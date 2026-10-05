/** Message purposes and offline templates (used when AI is off or unreachable). */
import type { Account, Contact, Settings } from './types';
import { fmtWhen } from './util';

export type Purpose = 'details' | 'reminder' | 'followup' | 'tried-calling' | 'referral-intro' | 'discovery-invite' | 'discovery-confirm' | 'recap' | 'breakup' | 'reconnect';
export type Tone = 'warm' | 'formal' | 'crisp';
export type Lang = 'English' | 'Hinglish' | 'Hindi';

export const PURPOSES: { id: Purpose; label: string }[] = [
  { id: 'details', label: 'Share our details' },
  { id: 'reminder', label: 'Did you get it?' },
  { id: 'followup', label: 'Follow-up' },
  { id: 'tried-calling', label: 'Tried calling you' },
  { id: 'referral-intro', label: 'Referred by a colleague' },
  { id: 'discovery-invite', label: 'Invite to discovery call' },
  { id: 'discovery-confirm', label: 'Confirm discovery call' },
  { id: 'recap', label: 'Discovery recap' },
  { id: 'breakup', label: 'Close the file?' },
  { id: 'reconnect', label: 'Reconnect after a while' },
];

export function suggestPurpose(a: Account, c?: Contact, referrer?: Contact): Purpose {
  const n = a.next;
  if (n?.type === 'send') return 'details';
  if (n?.type === 'remind') return 'reminder';
  if (a.status === 'parked') return 'reconnect';
  if (n?.type === 'discovery') return 'discovery-confirm';
  if (n?.type === 'followup') return a.cadence >= 8 ? 'breakup' : a.stage === 'discovery' ? 'recap' : 'followup';
  if (a.stage === 'engaged') return 'discovery-invite';
  if (a.attempts >= 2) return 'tried-calling';
  if (c?.referredBy && referrer && a.stage === 'intro') return 'referral-intro';
  return 'details';
}

interface Vars { a: Account; c?: Contact; referrer?: Contact; s: Settings; me: string; tone: Tone; lang: Lang; when?: string }

const first = (c?: Contact) => {
  const n = (c?.name || '').replace(/\(.*\)/, '').trim();
  return n ? n.split(' ')[0] : '';
};

export function template(p: Purpose, v: Vars): { subject: string; body: string } {
  const { a, s, me, tone, lang } = v;
  const name = first(v.c);
  const hi = lang !== 'English'
    ? `Namaste${name ? ` ${name} ji` : ''},`
    : tone === 'formal' ? `Dear ${name || 'Sir/Madam'},` : tone === 'crisp' ? `Hi${name ? ` ${name}` : ''},` : `Hi${name ? ` ${name}` : ''}, hope you're doing well.`;
  const sign = `\n\n${tone === 'formal' ? 'Regards' : 'Thanks'},\n${me}\n${s.signature}`;
  const deck = s.links.deck ? `\n\nDetails: ${s.links.deck}` : '';
  const site = s.links.website ? `\nWebsite: ${s.links.website}` : '';
  const book = s.links.booking ? `\nPick a slot: ${s.links.booking}` : '';
  const co = a.name.replace(/\s+(pvt\.?|private)?\s*(ltd\.?|limited)?$/i, '');
  const H = lang !== 'English';

  const bodies: Record<Purpose, [string, string]> = {
    details: [
      `As discussed on our call, sharing a quick overview of KensaraAI.`,
      H
        ? `Jaisa call pe baat hui, KensaraAI ki details share kar raha/rahi hoon. Hum companies ko DPDP Act aur baaki privacy laws ke liye ready karte hain — pehle 30 min ki discovery call, phir ek clear gap assessment.${deck}${site}\n\nAap ek baar dekh lijiye, koi bhi sawaal ho toh bataiye.`
        : `${s.pitch}${deck}${site}\n\nHappy to walk you through it — would a 30-minute discovery call this week work?`,
    ],
    reminder: [
      `Quick check — did you receive our details?`,
      H
        ? `Abhi thodi der pehle humne KensaraAI ki details bheji hain. Bas confirm karna tha ki aapko mil gayi. Koi sawaal ho toh yahin message kar dijiye.`
        : `I just shared our details a little while ago and wanted to make sure they reached you. If anything is unclear or you'd like a quick walkthrough, just reply here.`,
    ],
    followup: [
      `Following up on KensaraAI for ${co}`,
      H
        ? `Ek chhota sa follow-up — kya aapko humari details dekhne ka time mila? DPDP compliance ki timelines paas aa rahi hain, aur kai companies abhi se gap assessment kar rahi hain. 30 min ki call se aapko clear picture mil jayegi.`
        : `Following up on the details I shared. With DPDP compliance timelines approaching, many ${a.sector ? `${a.sector.toLowerCase()} ` : ''}companies are starting with a quick gap assessment to see where they stand. A 30-minute discovery call would give you a clear picture — no obligation.${book}`,
    ],
    'tried-calling': [
      `Tried reaching you`,
      H
        ? `Maine aapko call karne ki koshish ki thi. Main ${s.signature} se ${me} hoon — hum companies ko data privacy compliance (DPDP Act) mein help karte hain. Aapse 5 minute baat karne ka sahi time kya rahega?`
        : `I tried calling you a couple of times. I'm ${me} from ${s.signature} — we help companies get ready for India's DPDP Act and other privacy laws. When would be a good time for a quick 5-minute chat?`,
    ],
    'referral-intro': [
      `${first(v.referrer) || 'Your colleague'} suggested I reach out`,
      H
        ? `${first(v.referrer) || 'Aapke colleague'} ne aapka contact diya. Main ${me}, ${s.signature} se. Hum data privacy compliance (DPDP Act) mein companies ki help karte hain. Kya aaj ya kal 5 minute baat ho sakti hai?`
        : `${v.referrer?.name ? `${v.referrer.name.replace(/\(.*\)/, '').trim()} ` : 'Your colleague '}suggested I speak with you. I'm ${me} from ${s.signature} — we help companies like ${co} get compliant with the DPDP Act and global privacy laws. Could we speak for 5 minutes today or tomorrow?`,
    ],
    'discovery-invite': [
      `30-minute discovery call — ${co} x KensaraAI`,
      H
        ? `Aapke interest ke liye shukriya. Agla step ek 30 min ki discovery call hai humari expert team ke saath — ismein hum samjhenge ki aapke data practices kahan khade hain.${book}\n\nAapke liye kaunsa din aur time theek rahega?`
        : `Thanks for your interest. The next step is a 30-minute discovery call with our experts, where we understand your data practices and show where you stand against DPDP and other applicable laws.${book}\n\nWhich day and time suits you this week?`,
    ],
    'discovery-confirm': [
      `Confirmed: discovery call ${v.when ? `on ${v.when}` : ''}`,
      H
        ? `Humari discovery call ${v.when ? `${v.when} ko ` : ''}confirm hai. Agar aapki team se koi aur (IT / legal / compliance) join kar sake toh aur bhi useful rahega.`
        : `Looking forward to our discovery call${v.when ? ` on ${v.when}` : ''}. If someone from IT, legal or compliance can join, it will make the session even more useful.`,
    ],
    recap: [
      `Thank you — next steps from our discovery call`,
      H
        ? `Discovery call ke liye dhanyavaad. Jaisa discuss hua, agla step gap assessment hai jo aapko ek prioritised roadmap dega. Aap aage badhna chahenge toh main details bhej deta/deti hoon.`
        : `Thank you for your time on the discovery call. As discussed, the gap assessment maps your data practices, teams and systems and gives you a prioritised remediation roadmap. Shall I share the scope and timeline so you can take it forward internally?`,
    ],
    breakup: [
      `Should I close your file?`,
      H
        ? `Maine pichhle kuch hafton mein kuch baar contact kiya. Agar abhi ye priority nahi hai toh koi baat nahi — bas bata dijiye, main follow-up band kar dunga/dungi. Aur agar baad mein baat karni ho toh bas ek message kar dijiye.`
        : `I've reached out a few times over the past weeks and don't want to keep filling your inbox. If privacy compliance isn't a priority right now, just let me know and I'll close your file. If the timing is simply off, tell me when to check back.`,
    ],
    reconnect: [
      `Reconnecting — KensaraAI`,
      H
        ? `Kuch samay pehle humari baat hui thi aur aapne abhi reconnect karne ko kaha tha. Kya ab 10 minute baat karne ka sahi time hai?`
        : `We spoke a while ago and you asked me to reconnect around now. Is this a better time to take the conversation forward? Happy to set up a short call.`,
    ],
  };
  const [subject, body] = bodies[p];
  return { subject, body: `${hi}\n\n${body}${sign}` };
}

export const whenText = (iso?: string) => (iso ? fmtWhen(iso) : undefined);
