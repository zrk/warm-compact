// What warm-compact keeps in $.state: the armed timer of the session, so a
// reload of the module (which drops its timers) can arm it again, the main
// loop's last request, for a reload that lands as a turn ends, and the mark
// that a surface has drawn the session, so a reload while it is hidden does
// not take it for a headless run.
declare module 'claude-code' {
  interface PluginState {
    'warm-compact': {
      armed: WarmCompactArmed | null;
      drawn: WarmCompactDrawn | null;
      request: WarmCompactRequest | null;
    };
  }
}

export type WarmCompactRequest = {
  sessionId: string;
  // When the main loop last sent a request to the model, in $.clock.now() ms.
  at: number;
  // Whether the turn of that request has ended: a reload arms from it only then.
  ended: boolean;
};

export type WarmCompactDrawn = {
  sessionId: string;
};

export type WarmCompactArmed = {
  sessionId: string;
  // When the main loop last sent a request to the model, in $.clock.now() ms.
  lastRequestAt: number;
};
