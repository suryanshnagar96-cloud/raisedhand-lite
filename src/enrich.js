// Contact resolution.
//
// Real products call enrichment vendors here (Apollo, Hunter, Proxycurl, ...)
// and then verify. The interface is the interesting part: a provider returns
// either a contact with a verification flag, or nothing. It never invents.

const PROVIDERS = new Set(['demo', 'none']);

export const providerName = () => process.env.RH_ENRICH_PROVIDER || 'demo';

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * @param {object} person
 * @returns {{email?: {value:string, verified:boolean}, phone?: {value:string, verified:boolean}, source:string}}
 */
export function findContacts(person) {
  if (!PROVIDERS.has(providerName()) || providerName() === 'none') return { source: 'none' };

  const [first = '', last = ''] = String(person.name).toLowerCase().split(/\s+/);
  const domain = person.domain || `${(person.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`;
  const seed = hash(person.name + domain);

  // Demo rule: most people have a business email, some have a direct phone.
  const contacts = { source: 'demo' };
  if (seed % 10 !== 0) {
    contacts.email = {
      value: `${first}.${last}@${domain}`.replace(/\.@/, '@'),
      verified: seed % 7 !== 0,
    };
  }
  if (seed % 3 === 0) {
    contacts.phone = {
      value: `+1 ${200 + (seed % 700)} ${100 + (seed % 900)} ${1000 + (seed % 9000)}`,
      verified: seed % 5 !== 0,
    };
  }
  return contacts;
}

export function hasAnyContact(contacts) {
  return Boolean(contacts?.email?.value || contacts?.phone?.value);
}
