"use client";

import { useEffect, useState } from "react";
import { THEME_KEY as KEY } from "./themeBoot";

// Light/dark choice, remembered per browser. The design defaults to dark.
export type Theme = "light" | "dark";

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
    setTheme(next);
  }
  return [theme, toggle];
}
