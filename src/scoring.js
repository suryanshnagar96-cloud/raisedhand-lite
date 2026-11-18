// Scoring. Deterministic on purpose: every point is explainable, and the same
// signal always produces the same verdict. In production the last ~20 points
// would come from an LLM reading the whole profile; here the rules are the
// product, so you can see exactly why a lead scored what it did.

export const SIGNAL_WEIGHT = {
  posted: 3,
  commented: 2,
  engaged_competitor: 2,
  liked: 1,
  watchlist: 2,
  new_in_role: 1,
};

export const SIGNAL_RANK = [
  'posted',
  'commented',
  'engaged_competitor',
  'watchlist',
  'liked',
  'new_in_role',
];

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Phrase match on word boundaries: "COO" must not match "Coordinator".
const has = (haystack, needle) =>
  new RegExp(`(^|[^a-z0-9])${esc(String(needle).toLowerCase())}([^a-z0-9]|$)`, 'i').test(
    String(haystack || '').toLowerCase(),
  );

// Loose match: every word of the phrase must start a word in the haystack.
// "missed call" matches "missed 23 calls"; "student" matches "students".
const fuzzyHas = (haystack, needle) => {
  const text = String(haystack || '').toLowerCase();
  return String(needle)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => new RegExp(`(^|[^a-z0-9])${esc(word)}`, 'i').test(text));
};

const daysSince = (iso, now = Date.now()) =>
  Math.max(0, (now - new Date(iso).getTime()) / 86_400_000);

function sizeBucket(size) {
  if (!size) return 'unknown';
  if (size < 10) return '1-9';
  if (size < 50) return '10-49';
  if (size < 200) return '50-199';
  if (size < 1000) return '200-999';
  return '1000+';
}

const inRange = (size, range) => {
  if (!size || !range) return false;
  const [lo, hi] = range;
  return size >= lo && size <= hi;
};

/**
 * Score one (person, signal) pair against an ICP.
 * @returns {{ fit:number, eligible:boolean, reasons:string[], qualification:string }}
 */
export function scoreLead({ person, signal, icp, now = Date.now() }) {
  const reasons = [];
  let score = 0;
  let excluded = null;

  const haystack = [
    person.name,
    person.title,
    person.company,
    person.industry,
    signal?.text,
  ].join(' ');

  // Hard exclusions. These are what keep students, job seekers and other
  // agencies out of an agency owner's feed.
  for (const word of icp.negatives || []) {
    if (fuzzyHas(haystack, word)) {
      excluded = word;
      break;
    }
  }
  if (excluded) {
    return {
      fit: 12,
      eligible: false,
      reasons: [`Excluded: profile mentions "${excluded}"`],
      qualification: `Not a fit — matched the negative list on "${excluded}".`,
    };
  }

  // Title / seniority
  const titleHit = (icp.titles || []).find((t) => has(person.title, t));
  if (titleHit) {
    score += 32;
    reasons.push(`Title matches ICP ("${titleHit}")`);
  } else if (/\b(owner|founder|co-?founder|ceo|coo|cto|director|head|vp|partner|principal|manager)\b/i.test(person.title || '')) {
    score += 16;
    reasons.push('Senior enough to buy, but not a target title');
  } else {
    reasons.push('Title is outside the target roles');
  }

  // Industry
  const industryHit = (icp.industries || []).find((i) => has(person.industry, i) || has(person.company, i));
  if (industryHit) {
    score += 18;
    reasons.push(`Industry matches "${industryHit}"`);
  }

  // Company size
  if (inRange(person.companySize, icp.sizeRange)) {
    score += 12;
    reasons.push(`Company size ${sizeBucket(person.companySize)} is in range`);
  } else if (person.companySize) {
    reasons.push(`Company size ${sizeBucket(person.companySize)} is outside the target band`);
  }

  // Geography
  const geoHit = (icp.geos || []).find((g) => has(person.geo, g));
  if (geoHit) {
    score += 8;
    reasons.push(`Sells into ${geoHit}`);
  }

  // Problem language actually used by the person
  const hits = (icp.keywords || []).filter((k) => fuzzyHas(signal?.text, k) || fuzzyHas(signal?.context, k));
  if (hits.length) {
    score += Math.min(18, hits.length * 6);
    reasons.push(`Used their own words: ${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}`);
  }

  // Signal strength
  const kind = signal?.kind || 'liked';
  const weight = SIGNAL_WEIGHT[kind] ?? 1;
  score += weight * 4;
  reasons.push(`${labelSignal(kind)} (weight ${weight}/3)`);

  // Freshness — a two-week-old "we need this" is cold
  const age = daysSince(signal?.at, now);
  if (age < 1) {
    score += 8;
    reasons.push('Said it today');
  } else if (age < 3) {
    score += 5;
    reasons.push(`Said it ${Math.floor(age)} day(s) ago`);
  } else if (age < 7) {
    score += 2;
  }

  // A like with no title match is not a lead, it is a maybe.
  if (!titleHit && score > 62) score = 62;

  score = Math.max(0, Math.min(99, Math.round(score)));

  const band = score >= 90 ? 'Perfect fit' : score >= 80 ? 'Strong fit' : score >= 65 ? 'Possible fit' : 'Weak fit';

  return {
    fit: score,
    // A fit score is a ranking; eligibility is a gate. Without a target title
    // you are not a lead no matter how well everything else lines up.
    eligible: score >= 60 && Boolean(titleHit),
    reasons,
    qualification: `${band}. ${reasons.slice(0, 3).join('. ')}.`,
  };
}

export function labelSignal(kind) {
  return (
    {
      posted: 'Posted about the problem',
      commented: 'Commented that they need it',
      engaged_competitor: "Engaged with a competitor's post",
      liked: 'Liked a post about it',
      watchlist: 'Engaged with an account you watch',
      new_in_role: 'New in role and fits the ICP',
    }[kind] || kind
  );
}

/**
 * Group many signals for one person into a single lead candidate.
 * Posts outrank comments outrank likes, so we keep the strongest one as the
 * headline evidence and attach the rest as a timeline.
 */
export function bestSignal(signals) {
  return [...signals].sort(
    (a, b) =>
      SIGNAL_RANK.indexOf(a.kind) - SIGNAL_RANK.indexOf(b.kind) ||
      new Date(b.at) - new Date(a.at),
  )[0];
}
