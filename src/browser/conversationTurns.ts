import {
  CONVERSATION_MESSAGE_UNIT_SELECTOR,
  CONVERSATION_RESPONSE_BODY_SELECTOR,
  CONVERSATION_ROLE_MARKER_SELECTOR,
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  LEGACY_ASSISTANT_ROLE_SELECTOR,
} from "./constants.js";

/**
 * Browser-context function `(node) => role` shared by every consumer of the turn list, so
 * submit confirmation, response extraction, attachments, files/images and reattach agree on
 * which message is the user's. Returns the lower-case author role or '' when none is marked.
 */
export function buildConversationTurnRoleFunction(): string {
  const markerSelector = JSON.stringify(CONVERSATION_ROLE_MARKER_SELECTOR);
  return `((node) => {
    const own = (element) => {
      if (!element || typeof element.getAttribute !== 'function') return '';
      const marked = element.getAttribute('data-message-author-role') || element.getAttribute('data-turn');
      if (marked) return marked.toLowerCase();
      const unitRole = (key) => (/:([a-z]+)$/i.exec(key || '')?.[1] || '').toLowerCase();
      const unitKey = element.getAttribute('data-chatgpt-search-unit-key');
      if (unitKey !== null) return unitRole(unitKey);
      if (element.getAttribute('data-response-body') === null) return '';
      // A response body takes its unit's role; one outside any unit is an app response.
      const unit = element.closest?.('[data-chatgpt-search-unit-key]');
      return unit ? unitRole(unit.getAttribute('data-chatgpt-search-unit-key')) : 'assistant';
    };
    const direct = own(node);
    if (direct || typeof node?.querySelector !== 'function') return direct;
    const inner = node.querySelector(${markerSelector});
    if (inner) return own(inner);
    const testId = (node.getAttribute('data-testid') || '').toLowerCase();
    return testId.includes('assistant') || node.querySelector('[data-testid*="assistant"]')
      ? 'assistant'
      : '';
  })`;
}

/**
 * Build a browser-context expression that returns one DOM node per conversation message, in
 * DOM order, for the legacy markup, the current markup, and a page mixing both.
 *
 * A message nested inside another candidate (legacy turn container around its role node, a
 * unit around its response body) counts once as the outer node. A wrapper whose nested
 * messages carry different roles is a turn of several messages and is split into them.
 * Legacy role nodes are only a fallback when no legacy turn container exists, as before.
 */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const currentSelectors = JSON.stringify([
    CONVERSATION_MESSAGE_UNIT_SELECTOR,
    CONVERSATION_RESPONSE_BODY_SELECTOR,
  ]);
  return `(() => {
    const root = ${rootExpression};
    const roleOf = ${buildConversationTurnRoleFunction()};
    const selectors = [${containerSelector}, ...${currentSelectors}];
    if (root.querySelectorAll(${containerSelector}).length === 0) selectors.push(${fallbackSelector});
    const candidates = Array.from(root.querySelectorAll(selectors.join(', ')));
    const owned = new Set(candidates);
    const nestedOf = new Map();
    const outermost = [];
    for (const node of candidates) {
      let parent = node.parentElement;
      while (parent && !owned.has(parent)) parent = parent.parentElement;
      if (!parent) {
        outermost.push(node);
        continue;
      }
      if (!nestedOf.has(parent)) nestedOf.set(parent, []);
      nestedOf.get(parent).push(node);
    }
    const messages = [];
    const collect = (node) => {
      const nested = nestedOf.get(node) || [];
      if (new Set(nested.map(roleOf).filter(Boolean)).size > 1) {
        nested.forEach(collect);
        return;
      }
      messages.push(node);
    };
    outermost.forEach(collect);
    return messages;
  })()`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}

/**
 * Browser-context function `(turn) => node` giving the element that holds one listed message's
 * content. A current-markup unit reads from its single response body (leaving its "said:"
 * heading out) or, when it holds several, from the whole unit; a response body is its own
 * content; a legacy turn container holds its assistant role node.
 */
export function buildConversationMessageRootFunction(): string {
  const unitSelector = JSON.stringify(CONVERSATION_MESSAGE_UNIT_SELECTOR);
  const bodySelector = JSON.stringify(CONVERSATION_RESPONSE_BODY_SELECTOR);
  const legacySelector = JSON.stringify(LEGACY_ASSISTANT_ROLE_SELECTOR);
  return `((turn) => {
    if (turn.matches?.(${bodySelector})) return turn;
    if (turn.matches?.(${unitSelector})) {
      const bodies = turn.querySelectorAll(${bodySelector});
      return bodies.length === 1 ? bodies[0] : turn;
    }
    return turn.querySelector?.(${legacySelector}) || turn;
  })`;
}
