"use client";

import { useSyncExternalStore } from "react";
import type { Persona } from "./api";

// INTEGRATION 5.6: the JWT lives in memory + sessionStorage only.
const KEY = "proofwork.session";

export interface Session {
  token: string;
  persona: Persona;
}

let current: Session | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function load(): Session | null {
  if (loaded || typeof window === "undefined") return current;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    current = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    current = null;
  }
  return current;
}

export function getSession(): Session | null {
  return load();
}

export function setSession(next: Session | null): void {
  current = next;
  loaded = true;
  try {
    if (next) window.sessionStorage.setItem(KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked (private mode): the in-memory session still works for this tab.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, () => null);
}
