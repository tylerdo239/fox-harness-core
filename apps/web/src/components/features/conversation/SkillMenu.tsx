// "/" skill picker above the composer (docs/skill-transfer-plan.md). A
// `/name` token in a sent message is already understood by dsh-tool-skill in
// the worker — this only helps the user find and type the name.

import { useEffect, useRef, useState } from "react";

import { useLocale } from "../../../i18n/locale.tsx";
import type { Runtime } from "../../../runtime.ts";
import {
  refreshSkillMenu,
  subscribeSkillMenu,
  type SkillMenuItem,
} from "../skills/skillsApi.ts";

// The menu is open only while the whole message is still the command token.
export function slashQuery(text: string): string | undefined {
  return /^\/([a-z0-9-]*)$/.exec(text)?.[1];
}

export function useSkillMenu(runtime: Runtime): SkillMenuItem[] {
  const [items, setItems] = useState<SkillMenuItem[]>([]);
  useEffect(() => {
    const unsubscribe = subscribeSkillMenu(setItems);
    void refreshSkillMenu(runtime);
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return items;
}

export function SkillMenu({
  items,
  activeIndex,
  onChoose,
  onHover,
}: {
  items: SkillMenuItem[];
  activeIndex: number;
  onChoose: (name: string) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useLocale();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div ref={listRef} className="fh-skill-menu" role="listbox">
      {items.map((item, index) => (
        <button
          key={item.name}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`fh-skill-menu-item${index === activeIndex ? " active" : ""}`}
          // Keep focus in the composer so typing continues after a click.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onChoose(item.name)}
        >
          <span className="fh-skill-menu-name">
            /{item.name}
            {item.source === "custom" && (
              <span className="fh-skill-menu-badge">{t("skills.mineBadge")}</span>
            )}
          </span>
          <span className="fh-skill-menu-desc">{item.description}</span>
        </button>
      ))}
    </div>
  );
}
