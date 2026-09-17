"""Step 6 — Resolve joins + classify fan-out strategy (deterministic, no LLM).

This is the biggest upgrade over v1. v1 built one join skeleton and only noticed fan-out
AFTER executing (row-count ratio), then blindly retried. Here we decide the SHAPE of the
query up front from cardinalities:

  none       single table
  direct_ok  a 1:N join whose many-side is exactly what we're counting — fan-out is intended
  pre_agg    a measure on the one-side sits under an expanding branch — must aggregate the
             branch in a subquery first, or the measure gets duplicated per child row
  split_cte  two+ parallel 1:N branches off the grain — a Cartesian blow-up, so each branch
             is counted in its own CTE and joined back

Graph traversal reuses v1's relationship/column-pair model; only the classification is new.
"""

from collections import deque

from sqlmodel import Session, select

from src.database.models import EntityColumn, EntityRelationship, RelationshipColumnPair
from src.database.models.enums import Cardinality
from src.pipeline_v2.state import (
    ClarificationNeeded,
    JoinEdge,
    JoinPlanV2,
    JoinStrategy,
    PipelineState,
)


def run_step6(session: Session, state: PipelineState) -> None:
    target_ids = list(dict.fromkeys(state.target_entity_ids))
    grain_id = state.grain_entity_id or (target_ids[0] if target_ids else None)
    if grain_id is None:
        state.join_plan = JoinPlanV2(strategy=JoinStrategy.NONE)
        return

    if len(target_ids) <= 1:
        state.join_plan = JoinPlanV2(strategy=JoinStrategy.NONE)
        return

    adjacency = _build_adjacency(session)
    edges, unreachable, ambiguous = _connect(adjacency, grain_id, target_ids)

    if ambiguous:
        state.clarifications.append(
            ClarificationNeeded(
                slot="joins",
                question="There is more than one way to relate these tables; which path is intended?",
                options=ambiguous,
            )
        )

    join_edges = [_to_join_edge(session, e, grain_id, adjacency) for e in edges]
    strategy, note, expanding = _classify(session, state, grain_id, join_edges)

    state.join_plan = JoinPlanV2(
        strategy=strategy,
        edges=join_edges,
        fanout_note=note,
        expanding_branch_entity_ids=expanding,
        unreachable_entity_ids=unreachable,
    )
    if unreachable:
        state.add_assumption(
            f"Could not find a join path to entities {unreachable}; they were left out of the query."
        )


# ── graph layer (mirrors v1 join_path, kept local so v2 can evolve independently) ──

def _build_adjacency(session: Session) -> dict[int, list[tuple[EntityRelationship, int, int]]]:
    rels = session.exec(select(EntityRelationship)).all()
    adj: dict[int, list[tuple[EntityRelationship, int, int]]] = {}
    for rel in rels:
        adj.setdefault(rel.from_entity_id, []).append((rel, rel.from_entity_id, rel.to_entity_id))
        adj.setdefault(rel.to_entity_id, []).append((rel, rel.to_entity_id, rel.from_entity_id))
    return adj


def _bfs(adjacency, start_nodes: set[int], target: int):
    if target in start_nodes:
        return []
    visited = set(start_nodes)
    queue: deque = deque((n, []) for n in start_nodes)
    while queue:
        current, path = queue.popleft()
        for rel, from_id, to_id in adjacency.get(current, []):
            if to_id in visited:
                continue
            new_path = path + [(rel, from_id, to_id)]
            if to_id == target:
                return new_path
            visited.add(to_id)
            queue.append((to_id, new_path))
    return None


def _connect(adjacency, grain_id: int, target_ids: list[int]):
    """Grow a tree from the grain entity to every target. Returns (edges, unreachable,
    ambiguous_labels). Ambiguity = two shortest paths of equal length through different
    intermediate entities to the same target."""
    connected = {grain_id}
    edges: list[tuple[EntityRelationship, int, int]] = []
    unreachable: list[int] = []
    ambiguous: list[str] = []

    remaining = [t for t in target_ids if t != grain_id]
    for target in remaining:
        path = _bfs(adjacency, set(connected), target)
        if path is None:
            unreachable.append(target)
            continue
        if _has_equal_length_alternative(adjacency, connected, target, len(path)):
            ambiguous.append(f"entity {target}")
        for rel, from_id, to_id in path:
            if to_id in connected:
                continue
            edges.append((rel, from_id, to_id))
            connected.add(to_id)
    return edges, unreachable, ambiguous


def _has_equal_length_alternative(adjacency, start_nodes, target: int, best_len: int) -> bool:
    """Detect a second distinct shortest path of the same length reaching target through a
    different immediate neighbor of the connected set. Cheap ambiguity signal — catches the
    common 'two equally-short ways to join' case without enumerating all paths.

    For each neighbor of the connected set, we ask: is there a shortest path from that single
    neighbor to target whose total length (plus the one hop to reach the neighbor) equals
    best_len? If two different neighbors both qualify, the join is ambiguous."""
    qualifying_neighbors: set[int] = set()
    for node in start_nodes:
        for _rel, _from_id, to_id in adjacency.get(node, []):
            if to_id in start_nodes:
                continue
            sub = _bfs(adjacency, {to_id}, target)
            if sub is not None and len(sub) + 1 == best_len:
                qualifying_neighbors.add(to_id)
    return len(qualifying_neighbors) > 1


def _load_column_pair(session: Session, rel: EntityRelationship, from_id: int, to_id: int):
    pair = session.exec(
        select(RelationshipColumnPair)
        .where(RelationshipColumnPair.relationship_id == rel.id)
        .order_by(RelationshipColumnPair.seq)
    ).first()
    if pair is None:
        return None, None
    from_col = session.get(EntityColumn, pair.from_column_id)
    to_col = session.get(EntityColumn, pair.to_column_id)
    reversed_dir = from_id != rel.from_entity_id
    if reversed_dir:
        from_col, to_col = to_col, from_col
    return from_col, to_col


def _to_join_edge(session, edge, grain_id: int, adjacency) -> JoinEdge:
    rel, from_id, to_id = edge
    from_col, to_col = _load_column_pair(session, rel, from_id, to_id)
    # cardinality is stored on the relationship in its canonical from->to direction; if we
    # traverse it reversed, a 1:N becomes N:1 for the purpose of "does moving to to_id expand".
    expands = _edge_expands(rel, from_id)
    return JoinEdge(
        from_entity_id=from_id,
        to_entity_id=to_id,
        from_column_physical=from_col.physical_name if from_col else "",
        to_column_physical=to_col.physical_name if to_col else "",
        cardinality=rel.cardinality.value,
        expands_from_grain=expands,
    )


def _edge_expands(rel: EntityRelationship, from_id: int) -> bool:
    """Does traversing this edge away from `from_id` multiply rows (land on the N side)?
    Canonical direction is rel.from_entity_id -> rel.to_entity_id."""
    if rel.cardinality == Cardinality.ONE_TO_ONE:
        return False
    if rel.cardinality == Cardinality.MANY_TO_MANY:
        return True
    # ONE_TO_MANY: from(1) -> to(N). Expanding only when we move in the canonical direction.
    return from_id == rel.from_entity_id


# ── classification (the new logic) ──

def _classify(session, state: PipelineState, grain_id: int, edges: list[JoinEdge]):
    if not edges:
        return JoinStrategy.NONE, None, []

    expanding_branches = [e.to_entity_id for e in edges if e.expands_from_grain]

    # measures aggregated in this query, with the entity each measure column lives on
    measure_entity_ids = _measure_entity_ids(session, state)

    problems: list[str] = []
    # a measure on the one-side sitting under an expanding branch → duplication
    for e in edges:
        if e.expands_from_grain and _measure_on_one_side(measure_entity_ids, e, grain_id):
            problems.append("measure_on_one_side_under_expansion")

    # two or more expanding branches directly off the grain → Cartesian double fan-out
    direct_expanding = [e for e in edges if e.expands_from_grain and e.from_entity_id == grain_id]
    if len(direct_expanding) >= 2:
        problems.append("double_fanout")

    if "double_fanout" in problems:
        return JoinStrategy.SPLIT_CTE, "Two parallel 1:N branches — split into per-branch CTEs.", expanding_branches
    if problems:
        return JoinStrategy.PRE_AGG, "Measure on the one-side under a 1:N branch — pre-aggregate.", expanding_branches
    if expanding_branches:
        # rows expand, but we're counting the many-side itself (e.g. counting nodes) — intended
        return JoinStrategy.DIRECT_OK, "1:N join, counting the many-side directly — fan-out intended.", expanding_branches
    return JoinStrategy.NONE, None, []


def _measure_entity_ids(session, state: PipelineState) -> set[int]:
    ids: set[int] = set()
    for m in state.metrics:
        if m.expr_column_id is not None:
            col = session.get(EntityColumn, m.expr_column_id)
            if col is not None:
                ids.add(col.entity_id)
    return ids


def _measure_on_one_side(measure_entity_ids: set[int], edge: JoinEdge, grain_id: int) -> bool:
    """True if a measure lives on the 'one' side of an expanding edge (the grain/parent side),
    meaning the join would duplicate that measure value across the many-side child rows."""
    return edge.from_entity_id in measure_entity_ids and edge.from_entity_id == grain_id
