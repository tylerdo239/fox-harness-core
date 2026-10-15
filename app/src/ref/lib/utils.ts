// Copied from bot-data-studio-web-main/src/lib/utils.ts by scripts/sync-ref-profile.mjs — edit there, not here.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
