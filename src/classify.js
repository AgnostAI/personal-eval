// Fast, free, local labeling of the user's next message after a turn.
// Labels: not_meant | undo | redo | broken | nudge | none
// `--judge` replaces these with an LLM's labels (see judge.js).

export const LABELS = ['not_meant', 'undo', 'redo', 'broken', 'nudge', 'none'];

const NOT_MEANT = [
  /\bnot what i (meant|asked|wanted|said|was asking)\b/,
  /\bthat'?s not (what|it|right|correct|the (one|thing|file|issue|problem))\b/,
  /\bthat is not (what|it|right)\b/,
  /\bno,? i (meant|mean|asked|said|wanted)\b/,
  /\bi (meant|was asking|was talking about)\b/,
  /\bwhat i meant\b/,
  /\byou (misunderstood|misread|got it wrong|missed the point)\b/,
  /\bmisunderstood\b/,
  /\bi didn'?t (ask|say|mean|want) (you )?(to|for|that)\b/,
  /\b(re-?read|read) (my|the) (message|prompt|question|request)\b/,
  /\bwrong (file|thing|place|one|page|component|function|repo|branch|direction)\b/,
  /\bthat'?s the wrong\b/,
];

const UNDO = [
  /\bundo\b/,
  /\brevert\b/,
  /\broll ?back\b/,
  /\bput (it|that|them) back\b/,
  /\brestore (it|that|the (old|original|previous))\b/,
  /\bgo back to (the )?(previous|original|old|earlier)\b/,
  /\b(remove|delete|drop|get rid of) (that|this|it|those|these|what you (just )?(added|did|changed|wrote))\b/,
  /\bwhy did you (change|add|remove|delete|touch|modify|rename)\b/,
  /\b(don'?t|do not|never) (change|touch|modify|add|delete|remove) (that|this|it|those|the)\b/,
  /\bi didn'?t ask (you )?to (change|add|remove|delete|touch)\b/,
];

const REDO = [
  /\bredo\b/,
  /\bdo it again\b/,
  /\btry again\b/,
  /\bstart over\b/,
  /\bfrom scratch\b/,
  /\bi (don'?t|do not) like (it|this|that|the)\b/,
  /\bdon'?t like (it|this|that)\b/,
  /\bnot (good|great|right) enough\b/,
  /\b(this|that|it) (looks|is|feels) (bad|off|wrong|terrible|awful|ugly|weird|worse|meh|generic)\b/,
  /\b(ugly|terrible|awful|horrible)\b/,
  /\bmake it (better|nicer|cleaner)\b/,
  /\b(rewrite|rework|redesign) (it|this|that)\b/,
  /\b(different|another|better) approach\b/,
  /\bscrap (it|this|that)\b/,
];

const BROKEN = [
  /\bstill (broken|failing|fails|not working|doesn'?t work|wrong|the same|happening|getting|seeing|an issue|there|crash|error|throw|shows?|blank|empty|missing)\b/,
  /\b(it|this|that)('?s| is) (broken|not working|failing|wrong)\b/,
  /\b(doesn'?t|does not|didn'?t|did not|isn'?t|is not|won'?t|not) (work|working)\b/,
  /\b(it|this|that|which|still) (doesn'?t|does not|didn'?t|did not|won'?t) (fix|load|compile|build|render|start|run|show)\b/,
  /\b(didn'?t|did not|doesn'?t|does not) fix (it|the|anything)\b/,
  /\bnothing (happens|happened|changed|works)\b/,
  /\bsame (error|issue|problem|bug|result|thing)\b/,
  /\b(getting|got|seeing|throws?|throwing|see) (an? |the |this |that )?(error|exception|traceback|stack ?trace|500|404|crash)\b/,
  /\b(it|this|that|build|test|tests|page|app) (crash(es|ed)?|fails?|failed|errors?|broke)\b/,
  /\bbroke (it|the|everything|something)\b/,
  /\b(blank|white|empty) (page|screen)\b/,
  /^(error|traceback|exception|typeerror|referenceerror|syntaxerror)\b/,
];

const NUDGE = /^(continue|go on|keep going|carry on|resume|and\?|so\?|well\?|hello\?*|hey\?+|you there\??|are you there\??|status\?|any update\??|\?+|\.\.+)[\s.!?]*$/;

/** Normalize a follow-up for matching: drop code blocks/quotes, cap length, lowercase. */
export function normalize(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/[’‘]/g, "'")
    .slice(0, 500)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyFollowUp(text) {
  const t = normalize(text);
  if (!t) return 'none';
  if (NUDGE.test(t)) return 'nudge';
  if (UNDO.some((r) => r.test(t))) return 'undo';
  if (NOT_MEANT.some((r) => r.test(t))) return 'not_meant';
  if (BROKEN.some((r) => r.test(t))) return 'broken';
  if (REDO.some((r) => r.test(t))) return 'redo';
  return 'none';
}
