const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const CYAN = '\u001b[38;5;6m';
const MODEL = '\u001b[38;2;246;226;183m';
const PATH = '\u001b[38;2;171;223;167m';

export const REAL_MEDIUM_BEFORE_WRITE_FRAME =
  `${RESET}${BOLD}› ${RESET}${DIM}Improve documentation in @filename${RESET}\r\n\r\n` +
  `  ${RESET}${MODEL}gpt-5.6-terra medium${RESET}${DIM} · ${RESET}` +
  `${PATH}/var/home/theuser/.throne/worktrees/d…${RESET}`;

export const REAL_MEDIUM_AFTER_WRITE_BLANK_REPAINT_FRAME =
  REAL_MEDIUM_BEFORE_WRITE_FRAME;

export const REAL_MEDIUM_FOLDED_DRAFT_FRAME =
  `${RESET}${BOLD}› ${RESET}${CYAN}[Pasted Content 1024 chars]${RESET}\r\n\r\n` +
  `  ${RESET}${MODEL}gpt-5.6-terra medium${RESET}${DIM} · ${RESET}` +
  `${PATH}/var/home/theuser/.throne/worktrees/d…${RESET}`;

export const REAL_MEDIUM_EXPANDED_DRAFT_FRAME =
  `${RESET}${BOLD}› ${RESET}${CYAN}[Pasted Content 1024${RESET}\r\n` +
  `  ${RESET}${CYAN}chars]${RESET}zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\r\n` +
  `  zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz|LMB_END\r\n\r\n\r\n` +
  `  ${RESET}${MODEL}gpt-5.6-terra medium${RESET}${DIM} · ${RESET}` +
  `${PATH}/var/home/theuser/.throne/worktrees/d…${RESET}`;

export const REAL_MEDIUM_CLEARED_FRAME =
  `${RESET}${BOLD}${DIM}› ${RESET}shadow-lmb-01-audit-sol said: LMB_REAL_IDLE_1500|\r\n` +
  `  zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz|LMB_END\r\n\r\n\r\n` +
  `${RESET}${BOLD}› ${RESET}${DIM}Improve documentation in @filename${RESET}\r\n\r\n` +
  `  ${RESET}${MODEL}gpt-5.6-terra medium${RESET}${DIM} · ${RESET}` +
  `${PATH}/var/home/theuser/.throne/worktrees/d…${RESET}`;

export const REAL_TORN_MEDIUM_FRAME =
  '› CANARY_CODEX_LARGE_..._L555\r\n' +
  '  abcdefghijklmnopqrstuvwxyz0123456789\r\n' +
  '    gh-axi                                  556';

export const REAL_UNAVAILABLE_REPAINT_FRAME =
  `${RESET}${BOLD}${DIM}• Working ${RESET}${DIM}(0s • esc to interrupt)${RESET}`;
