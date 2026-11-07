// Server-safe: the root layout inlines this before first paint. The design defaults to dark.
export const THEME_KEY = "pw-theme";
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){}`;
