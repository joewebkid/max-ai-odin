const FENCED_CODE_PATTERN = /(```[\s\S]*?```)/g;
const INLINE_CODE_PATTERN = /(`[^`\n]+`)/g;

const LATEX_COMMAND_MAP = new Map([
  ['Longleftrightarrow', '⟺'],
  ['Leftrightarrow', '⇔'],
  ['Longrightarrow', '⟹'],
  ['Longleftarrow', '⟸'],
  ['Rightarrow', '⇒'],
  ['Leftarrow', '⇐'],
  ['rightarrow', '→'],
  ['leftarrow', '←'],
  ['leftrightarrow', '↔'],
  ['mapsto', '↦'],
  ['implies', '⇒'],
  ['iff', '⇔'],
  ['therefore', '∴'],
  ['because', '∵'],
  ['forall', '∀'],
  ['exists', '∃'],
  ['nexists', '∄'],
  ['partial', '∂'],
  ['nabla', '∇'],
  ['infty', '∞'],
  ['approx', '≈'],
  ['neq', '≠'],
  ['ne', '≠'],
  ['leq', '≤'],
  ['geq', '≥'],
  ['ll', '≪'],
  ['gg', '≫'],
  ['times', '×'],
  ['cdot', '·'],
  ['pm', '±'],
  ['mp', '∓'],
  ['div', '÷'],
  ['propto', '∝'],
  ['subseteq', '⊆'],
  ['supseteq', '⊇'],
  ['subset', '⊂'],
  ['supset', '⊃'],
  ['in', '∈'],
  ['notin', '∉'],
  ['ni', '∋'],
  ['cup', '∪'],
  ['cap', '∩'],
  ['setminus', '∖'],
  ['emptyset', '∅'],
  ['varnothing', '∅'],
  ['infty', '∞'],
  ['sum', 'Σ'],
  ['prod', 'Π'],
  ['int', '∫'],
  ['iint', '∬'],
  ['iiint', '∭'],
  ['oint', '∮'],
  ['angle', '∠'],
  ['triangle', '△'],
  ['perp', '⟂'],
  ['parallel', '∥'],
  ['sim', '∼'],
  ['simeq', '≃'],
  ['equiv', '≡'],
  ['cong', '≅'],
  ['to', '→'],
  ['to', '→'],
  ['ldots', '…'],
  ['cdots', '⋯'],
  ['vdots', '⋮'],
  ['ddots', '⋱'],
  ['alpha', 'α'],
  ['beta', 'β'],
  ['gamma', 'γ'],
  ['delta', 'δ'],
  ['epsilon', 'ε'],
  ['varepsilon', 'ε'],
  ['zeta', 'ζ'],
  ['eta', 'η'],
  ['theta', 'θ'],
  ['vartheta', 'ϑ'],
  ['iota', 'ι'],
  ['kappa', 'κ'],
  ['lambda', 'λ'],
  ['mu', 'μ'],
  ['nu', 'ν'],
  ['xi', 'ξ'],
  ['pi', 'π'],
  ['varpi', 'ϖ'],
  ['rho', 'ρ'],
  ['varrho', 'ϱ'],
  ['sigma', 'σ'],
  ['varsigma', 'ς'],
  ['tau', 'τ'],
  ['upsilon', 'υ'],
  ['phi', 'φ'],
  ['varphi', 'φ'],
  ['chi', 'χ'],
  ['psi', 'ψ'],
  ['omega', 'ω'],
  ['Gamma', 'Γ'],
  ['Delta', 'Δ'],
  ['Theta', 'Θ'],
  ['Lambda', 'Λ'],
  ['Xi', 'Ξ'],
  ['Pi', 'Π'],
  ['Sigma', 'Σ'],
  ['Upsilon', 'Υ'],
  ['Phi', 'Φ'],
  ['Psi', 'Ψ'],
  ['Omega', 'Ω'],
]);

const SUPERSCRIPT_MAP = new Map([
  ['0', '⁰'],
  ['1', '¹'],
  ['2', '²'],
  ['3', '³'],
  ['4', '⁴'],
  ['5', '⁵'],
  ['6', '⁶'],
  ['7', '⁷'],
  ['8', '⁸'],
  ['9', '⁹'],
  ['+', '⁺'],
  ['-', '⁻'],
  ['=', '⁼'],
  ['(', '⁽'],
  [')', '⁾'],
  ['n', 'ⁿ'],
  ['i', 'ⁱ'],
  ['a', 'ᵃ'],
  ['b', 'ᵇ'],
  ['c', 'ᶜ'],
  ['d', 'ᵈ'],
  ['e', 'ᵉ'],
  ['f', 'ᶠ'],
  ['g', 'ᵍ'],
  ['h', 'ʰ'],
  ['j', 'ʲ'],
  ['k', 'ᵏ'],
  ['l', 'ˡ'],
  ['m', 'ᵐ'],
  ['o', 'ᵒ'],
  ['p', 'ᵖ'],
  ['r', 'ʳ'],
  ['s', 'ˢ'],
  ['t', 'ᵗ'],
  ['u', 'ᵘ'],
  ['v', 'ᵛ'],
  ['w', 'ʷ'],
  ['x', 'ˣ'],
  ['y', 'ʸ'],
  ['z', 'ᶻ'],
]);

const SUBSCRIPT_MAP = new Map([
  ['0', '₀'],
  ['1', '₁'],
  ['2', '₂'],
  ['3', '₃'],
  ['4', '₄'],
  ['5', '₅'],
  ['6', '₆'],
  ['7', '₇'],
  ['8', '₈'],
  ['9', '₉'],
  ['+', '₊'],
  ['-', '₋'],
  ['=', '₌'],
  ['(', '₍'],
  [')', '₎'],
  ['a', 'ₐ'],
  ['e', 'ₑ'],
  ['h', 'ₕ'],
  ['i', 'ᵢ'],
  ['j', 'ⱼ'],
  ['k', 'ₖ'],
  ['l', 'ₗ'],
  ['m', 'ₘ'],
  ['n', 'ₙ'],
  ['o', 'ₒ'],
  ['p', 'ₚ'],
  ['r', 'ᵣ'],
  ['s', 'ₛ'],
  ['t', 'ₜ'],
  ['u', 'ᵤ'],
  ['v', 'ᵥ'],
  ['x', 'ₓ'],
  ['β', 'ᵦ'],
  ['γ', 'ᵧ'],
  ['ρ', 'ᵨ'],
  ['φ', 'ᵩ'],
  ['χ', 'ᵪ'],
]);

const WRAPPER_COMMANDS = [
  'text',
  'mathrm',
  'mathit',
  'mathbf',
  'mathsf',
  'mathtt',
  'operatorname',
  'boxed',
  'underline',
  'overline',
  'boldsymbol',
];

function splitProtected(text, pattern, transform) {
  return text
    .split(pattern)
    .map((part) => {
      if (!part) {
        return part;
      }

      pattern.lastIndex = 0;
      const isProtected = pattern.test(part);
      pattern.lastIndex = 0;
      return isProtected ? part : transform(part);
    })
    .join('');
}

function wrapIfNeeded(value) {
  const normalized = value.trim();

  if (!normalized) {
    return normalized;
  }

  if (
    (normalized.startsWith('(') && normalized.endsWith(')'))
    || /^[A-Za-zА-Яа-я0-9α-ωΑ-Ω]+(?:\([^()]*\))?$/u.test(normalized)
  ) {
    return normalized;
  }

  if (/^[A-Za-zА-Яа-я0-9α-ωΑ-Ω]+$/u.test(normalized)) {
    return normalized;
  }

  return `(${normalized})`;
}

function convertScriptToken(token, map, fallbackPrefix) {
  const normalized = token.trim();

  if (!normalized) {
    return '';
  }

  const converted = [];

  for (const character of normalized) {
    const replacement = map.get(character) ?? map.get(character.toLowerCase());

    if (!replacement) {
      return `${fallbackPrefix}${wrapIfNeeded(normalized)}`;
    }

    converted.push(replacement);
  }

  return converted.join('');
}

function unwrapCommand(result, command) {
  const pattern = new RegExp(`\\\\${command}\\s*\\{([^{}]+)\\}`, 'g');
  return result.replace(pattern, '$1');
}

function normalizeFractions(result) {
  let next = result;

  for (let iteration = 0; iteration < 6; iteration += 1) {
    const updated = next
      .replace(/\\(?:dfrac|tfrac|frac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_, numerator, denominator) => {
        const left = wrapIfNeeded(normalizeFormula(numerator));
        const right = wrapIfNeeded(normalizeFormula(denominator));
        return `${left}/${right}`;
      })
      .replace(/\\sqrt\s*\[([^[\]{}]+)\]\s*\{([^{}]+)\}/g, (_, degree, value) => {
        return `√[${normalizeFormula(degree)}](${normalizeFormula(value)})`;
      })
      .replace(/\\sqrt\s*\{([^{}]+)\}/g, (_, value) => `√(${normalizeFormula(value)})`);

    if (updated === next) {
      break;
    }

    next = updated;
  }

  return next;
}

function normalizeFormula(result) {
  let normalized = result;

  normalized = normalizeFractions(normalized);

  for (const command of WRAPPER_COMMANDS) {
    normalized = unwrapCommand(normalized, command);
  }

  normalized = normalized
    .replace(/\\left/g, '')
    .replace(/\\right/g, '')
    .replace(/\\(?:,|;|:|!|quad|qquad)\b/g, ' ')
    .replace(/\\,/g, ' ');

  normalized = normalized.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (match, command) => {
    return LATEX_COMMAND_MAP.get(command) ?? match;
  });

  normalized = normalized
    .replace(/\\\\/g, '\n')
    .replace(/\\\{/g, '{')
    .replace(/\\\}/g, '}');

  normalized = normalized
    .replace(/([∫ΣΠ])_\{([^{}]+)\}\^\{([^{}]+)\}/g, (_, symbol, lower, upper) => {
      return `${symbol}${convertScriptToken(normalizeFormula(lower), SUBSCRIPT_MAP, '_')}${convertScriptToken(normalizeFormula(upper), SUPERSCRIPT_MAP, '^')}`;
    })
    .replace(/([∫ΣΠ])_([^\s^_{}]+)\^([^\s^_{}]+)/g, (_, symbol, lower, upper) => {
      return `${symbol}${convertScriptToken(normalizeFormula(lower), SUBSCRIPT_MAP, '_')}${convertScriptToken(normalizeFormula(upper), SUPERSCRIPT_MAP, '^')}`;
    });

  normalized = normalized
    .replace(/(?<![\p{L}\p{N}])([\p{L}\p{N})\]∫ΣΠ√])\^\{([^{}]+)\}/gu, (_, base, token) => {
      return `${base}${convertScriptToken(normalizeFormula(token), SUPERSCRIPT_MAP, '^')}`;
    })
    .replace(/(?<![\p{L}\p{N}])([\p{L}\p{N})\]∫ΣΠ√])_\\?\{([^{}]+)\}/gu, (_, base, token) => {
      return `${base}${convertScriptToken(normalizeFormula(token), SUBSCRIPT_MAP, '_')}`;
    })
    .replace(/(?<![\p{L}\p{N}])([\p{L}\p{N})\]∫ΣΠ√])\^(-?[\p{L}\p{N}]+)/gu, (_, base, token) => {
      return `${base}${convertScriptToken(token, SUPERSCRIPT_MAP, '^')}`;
    })
    .replace(/(?<![\p{L}\p{N}])([\p{L}\p{N})\]∫ΣΠ√])_([\p{L}\p{N}]+)/gu, (_, base, token) => {
      return `${base}${convertScriptToken(token, SUBSCRIPT_MAP, '_')}`;
    });

  normalized = normalized
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, token) => `\n${normalizeFormula(token.trim())}\n`)
    .replace(/\\\[((?:[\s\S]+?))\\\]/g, (_, token) => `\n${normalizeFormula(token.trim())}\n`)
    .replace(/\\\(((?:[\s\S]+?))\\\)/g, (_, token) => normalizeFormula(token.trim()))
    .replace(/(?<!\$)\$([^\n$]+?)\$(?!\$)/g, (_, token) => normalizeFormula(token.trim()));

  return normalized
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePlainText(text) {
  const leadingWhitespace = text.match(/^\s*/)?.[0] ?? '';
  const trailingWhitespace = text.match(/\s*$/)?.[0] ?? '';
  const core = text.trim();

  if (!core) {
    return text;
  }

  return `${leadingWhitespace}${normalizeFormula(core)}${trailingWhitespace}`;
}

export function normalizeTextForMax(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return text;
  }

  return splitProtected(text, FENCED_CODE_PATTERN, (plainChunk) => (
    splitProtected(plainChunk, INLINE_CODE_PATTERN, normalizePlainText)
  ));
}
