// Lightweight coordination between the /session screen and child flows
// (currently ShadowSentenceFlow) that show their own confirmation dialog
// before letting the user leave.
//
// Without this, both layers react to the same `beforeRemove` event: the
// child shows its "discard progress?" alert, but the session screen has
// already started its reverse card-collapse animation. By the time the
// user taps "Stay", the card has visually collapsed even though we're
// still on the session screen.
//
// Flow:
//   - ShadowSentenceFlow registers itself as the leave interceptor while
//     the user has unfinished progress.
//   - The session screen, on `beforeRemove`, checks the interceptor flag
//     and — when set — only calls `preventDefault()`, deferring the
//     animation to the child.
//   - On "Discard" the child invokes the close-animation runner the
//     session screen exposed here, then dispatches the navigation pop.

type CloseRunner = (onDone: () => void) => void;

const state: {
  active: boolean;
  closeRunner: CloseRunner | null;
} = {
  active: false,
  closeRunner: null,
};

export function setSessionCloseRunner(runner: CloseRunner | null): void {
  state.closeRunner = runner;
}

export function getSessionCloseRunner(): CloseRunner | null {
  return state.closeRunner;
}

export function setShadowLeaveIntercept(active: boolean): void {
  state.active = active;
}

export function isShadowLeaveIntercepted(): boolean {
  return state.active;
}
