// The admin paste-box grammar for one tile, kept out of Admin.jsx so it can be
// exercised without rendering React. The database still validates every rule;
// this parser's job is to turn mistakes into a line-numbered message before a
// 100-tile replacement reaches it.

const INTEGER = /^\d+$/;

function optionParts(part, rule) {
  let spec = part.trim();
  let points = 1;

  if (rule === 'points') {
    const colon = spec.lastIndexOf(':');
    if (colon === -1) return { label: spec, points: NaN };
    points = INTEGER.test(spec.slice(colon + 1).trim())
      ? Number(spec.slice(colon + 1).trim())
      : NaN;
    spec = spec.slice(0, colon).trim();
  } else if (spec.includes(':')) {
    return { label: spec, points: NaN };
  }

  const slash = spec.indexOf('/');
  if (slash === -1) return { label: spec, points };
  return {
    grp: spec.slice(0, slash).trim(),
    label: spec.slice(slash + 1).trim(),
    points,
  };
}

function amountParts(raw) {
  const value = raw.trim();
  if (!value) return { rule: 'points' };

  if (/^set$/i.test(value)) return { rule: 'one_set' };

  const each = value.match(/^each(?:\s+(\d+))?$/i);
  if (each) {
    return {
      rule: 'each_set',
      perSet: each[1] ? Number(each[1]) : 1,
    };
  }

  const worth = value.match(/^(\d+)m$/i);
  if (worth) return { rule: 'value', amount: Number(worth[1]) };

  const count = value.match(/^(\d+)(\+)?$/);
  if (count) {
    return {
      rule: 'points',
      amount: Number(count[1]),
      ...(count[2] ? { early: true } : {}),
    };
  }

  return { rule: 'invalid', rawRule: value };
}

export function parseTileLine(rawLine, index, gridSize) {
  const sep = rawLine.indexOf('::');
  const line = sep === -1 ? rawLine : rawLine.slice(0, sep).trim();
  const description = sep === -1 ? '' : rawLine.slice(sep + 2).trim();

  // A `>` in the name is prose. Option syntax starts only after the first pipe.
  const firstPipe = line.indexOf('|');
  const gt = firstPipe === -1 ? -1 : line.indexOf('>', firstPipe);
  const head = gt === -1 ? line : line.slice(0, gt);
  const tail = gt === -1 ? '' : line.slice(gt + 1);
  const fields = head.split('|');
  const [name, icon, amount = ''] = fields;
  const mechanics = amountParts(amount);
  const options = tail
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => optionParts(part, mechanics.rule));

  return {
    row: Math.floor(index / gridSize) + 1,
    col: (index % gridSize) + 1,
    name: (name ?? '').trim(),
    icon: (icon ?? '').trim(),
    ...(mechanics.amount !== undefined ? { amount: mechanics.amount } : {}),
    ...(mechanics.early ? { early: true } : {}),
    ...(mechanics.rule !== 'points' && mechanics.rule !== 'invalid'
      ? { rule: mechanics.rule }
      : {}),
    ...(mechanics.perSet !== undefined ? { perSet: mechanics.perSet } : {}),
    ...(options.length ? { options } : {}),
    ...(description ? { description } : {}),
    _parse: {
      fields: fields.length,
      rule: mechanics.rule,
      rawRule: mechanics.rawRule,
    },
  };
}

export function parseTileText(text, gridSize) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map((line, index) => parseTileLine(line, index, gridSize));
  const errors = [];

  parsed.forEach((row, index) => {
    const at = `Line ${index + 1}`;
    const rule = row._parse.rule;
    const options = row.options ?? [];

    if (row._parse.fields > 3) {
      errors.push(`${at} has more than three pipe-separated fields before its description.`);
    }
    if (rule === 'invalid') {
      errors.push(`${at} has an unknown completion rule: ${row._parse.rawRule}.`);
      return;
    }

    if (rule === 'points' && row.amount !== undefined && (row.amount < 1 || row.amount > 30)) {
      errors.push(`${at} asks for evidence outside 1–30.`);
    }
    if (rule === 'value' && (row.amount < 1 || row.amount > 1000)) {
      errors.push(`${at} asks for a value outside 1–1000m.`);
    }
    if (rule === 'each_set' && (row.perSet < 1 || row.perSet > 30)) {
      errors.push(`${at} asks for a per-set count outside 1–30.`);
    }

    if ((rule === 'one_set' || rule === 'each_set') && options.length === 0) {
      errors.push(`${at} uses a set rule but lists no drops.`);
    }
    if (rule === 'value' && options.length > 0) {
      errors.push(`${at} is value-based and cannot also list drops.`);
    }
    if (rule !== 'points' && row.early) {
      errors.push(`${at} cannot combine its completion rule with +.`);
    }
    if (rule === 'points' && options.length > 0 && (row.amount ?? 1) <= 1) {
      errors.push(`${at} prices its drops but asks for no points target.`);
    }
    if (rule === 'points' && options.length > 0 && row.early) {
      errors.push(`${at} cannot combine priced drops with +.`);
    }

    const badOption = options.some((option) =>
      !option.label || option.grp === '' || !Number.isFinite(option.points)
      || option.points < 1 || option.points > 30
    );
    if (badOption) {
      errors.push(
        rule === 'points'
          ? `${at} has a drop without a name or points from 1–30.`
          : `${at} has an empty group/drop, or uses points on a set option.`
      );
    }

    const seen = new Set();
    if (options.some((option) => {
      const key = `${option.grp ?? ''}\u0000${option.label.toLowerCase()}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    })) {
      errors.push(`${at} lists the same drop twice in one group.`);
    }

    if (rule === 'each_set' && row.perSet > 1) {
      const sizes = new Map();
      for (const option of options) {
        const group = option.grp || option.label;
        sizes.set(group, (sizes.get(group) ?? 0) + 1);
      }
      if ([...sizes.values()].some((size) => size < row.perSet)) {
        errors.push(`${at} has a group with fewer than ${row.perSet} distinct drops.`);
      }
    }
  });

  const rows = parsed.map(({ _parse, ...row }) => row);
  return { lines, rows, errors };
}
