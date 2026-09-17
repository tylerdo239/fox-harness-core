from collections import deque
from dataclasses import dataclass, field

from sqlmodel import Session, select

from src.database.models import Entity, EntityColumn, EntityRelationship, RelationshipColumnPair
from src.database.models.enums import Cardinality, JoinType


class JoinPathError(Exception):
    pass


@dataclass
class JoinColumnPair:
    from_column_physical_name: str
    to_column_physical_name: str
    seq: int


@dataclass
class JoinStep:
    from_entity_id: int
    from_entity_physical_path: str
    to_entity_id: int
    to_entity_physical_path: str
    join_type: JoinType
    cardinality: Cardinality
    column_pairs: list[JoinColumnPair]
    is_fanout_risk: bool


@dataclass
class JoinPlan:
    root_entity_id: int
    root_entity_physical_path: str
    steps: list[JoinStep] = field(default_factory=list)
    fanout_warnings: list[str] = field(default_factory=list)
    unreachable_entity_ids: list[int] = field(default_factory=list)


def render_from_clause(plan: JoinPlan) -> str:
    """Render the join plan as a FROM/JOIN SQL skeleton. Deterministic, code-only —
    the model never sees or writes this; it only fills SELECT/WHERE expressions on top."""
    lines = [f"FROM {plan.root_entity_physical_path}"]

    for step in plan.steps:
        join_keyword = "LEFT JOIN" if step.join_type == JoinType.LEFT else "JOIN"
        on_clause = " AND ".join(
            f'{step.from_entity_physical_path}."{p.from_column_physical_name}" = '
            f'{step.to_entity_physical_path}."{p.to_column_physical_name}"'
            for p in step.column_pairs
        )
        lines.append(f"{join_keyword} {step.to_entity_physical_path} ON {on_clause}")

    return "\n".join(lines)


def build_join_path(session: Session, entity_ids: list[int]) -> JoinPlan:
    """Find the minimal join path connecting all requested entities via BFS over
    the relationships graph. The model never writes joins — this is pure code."""
    unique_entity_ids = list(dict.fromkeys(entity_ids))
    if not unique_entity_ids:
        raise JoinPathError("At least one entity is required")

    entities_by_id = _load_entities(session, unique_entity_ids)
    for eid in unique_entity_ids:
        if eid not in entities_by_id:
            raise JoinPathError(f"Entity {eid} not found")

    adjacency = _build_adjacency(session)

    root_id = unique_entity_ids[0]
    plan = JoinPlan(
        root_entity_id=root_id,
        root_entity_physical_path=entities_by_id[root_id].physical_path,
    )

    connected = {root_id}
    remaining = set(unique_entity_ids[1:])

    while remaining:
        target = next(iter(remaining))
        path_edges = _bfs_shortest_path(adjacency, connected, target)

        if path_edges is None:
            plan.unreachable_entity_ids.append(target)
            remaining.discard(target)
            continue

        for rel, from_id, to_id in path_edges:
            if to_id in connected:
                continue

            column_pairs = _load_column_pairs(session, rel, from_id, to_id)
            is_fanout = rel.cardinality in (Cardinality.ONE_TO_MANY, Cardinality.MANY_TO_MANY)

            step = JoinStep(
                from_entity_id=from_id,
                from_entity_physical_path=_entity_path(session, entities_by_id, from_id),
                to_entity_id=to_id,
                to_entity_physical_path=_entity_path(session, entities_by_id, to_id),
                join_type=rel.join_type_default,
                cardinality=rel.cardinality,
                column_pairs=column_pairs,
                is_fanout_risk=is_fanout,
            )
            plan.steps.append(step)
            connected.add(to_id)

            if is_fanout:
                plan.fanout_warnings.append(
                    f"Joining {step.from_entity_physical_path} -> {step.to_entity_physical_path} "
                    f"is {rel.cardinality.value}: measures on {step.from_entity_physical_path} "
                    f"may be duplicated (fan-out)."
                )

        remaining.discard(target)

    return plan


def _load_entities(session: Session, entity_ids: list[int]) -> dict[int, Entity]:
    entities = session.exec(select(Entity).where(Entity.id.in_(entity_ids))).all()
    return {e.id: e for e in entities}


def _entity_path(session: Session, cache: dict[int, Entity], entity_id: int) -> str:
    if entity_id not in cache:
        entity = session.get(Entity, entity_id)
        if entity is None:
            raise JoinPathError(f"Entity {entity_id} not found")
        cache[entity_id] = entity
    return cache[entity_id].physical_path


def _build_adjacency(session: Session) -> dict[int, list[tuple[EntityRelationship, int, int]]]:
    """Undirected adjacency: each relationship contributes edges in both directions."""
    relationships = session.exec(select(EntityRelationship)).all()
    adjacency: dict[int, list[tuple[EntityRelationship, int, int]]] = {}

    for rel in relationships:
        adjacency.setdefault(rel.from_entity_id, []).append((rel, rel.from_entity_id, rel.to_entity_id))
        adjacency.setdefault(rel.to_entity_id, []).append((rel, rel.to_entity_id, rel.from_entity_id))

    return adjacency


def _bfs_shortest_path(
    adjacency: dict[int, list[tuple[EntityRelationship, int, int]]],
    start_nodes: set[int],
    target: int,
) -> list[tuple[EntityRelationship, int, int]] | None:
    """BFS from any of start_nodes to target. Returns the edge path, or None if unreachable."""
    if target in start_nodes:
        return []

    visited = set(start_nodes)
    queue: deque[tuple[int, list[tuple[EntityRelationship, int, int]]]] = deque(
        (node, []) for node in start_nodes
    )

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


def _load_column_pairs(
    session: Session, rel: EntityRelationship, from_id: int, to_id: int
) -> list[JoinColumnPair]:
    pairs = session.exec(
        select(RelationshipColumnPair)
        .where(RelationshipColumnPair.relationship_id == rel.id)
        .order_by(RelationshipColumnPair.seq)
    ).all()

    reversed_direction = from_id != rel.from_entity_id

    result = []
    for pair in pairs:
        from_col = session.get(EntityColumn, pair.from_column_id)
        to_col = session.get(EntityColumn, pair.to_column_id)
        if from_col is None or to_col is None:
            raise JoinPathError(f"Column pair {pair.id} references a missing column")

        if reversed_direction:
            from_name, to_name = to_col.physical_name, from_col.physical_name
        else:
            from_name, to_name = from_col.physical_name, to_col.physical_name

        result.append(JoinColumnPair(from_name, to_name, pair.seq))

    return result
