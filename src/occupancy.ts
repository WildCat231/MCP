/**
 * `find_incumbents` — occupancy sweep with a positive control.
 *
 * Asks whether anyone is already working on an idea, across literature,
 * patents, companies, consortia, regulators, and news.
 *
 * ## Why the control is mandatory
 *
 * A zero is the whole point of this tool and also its central hazard. "No
 * incumbents found" and "the sweep did not work" produce identical output, and
 * the first is a green light to build while the second is nothing at all. A
 * caller who cannot tell them apart will read a rate limit as an empty market.
 *
 * So `control_terms` is required, not optional: a category the caller already
 * knows is occupied, run through the SAME channels with the SAME machinery. If
 * the control comes back empty in a channel, that channel is broken, blocked,
 * or badly queried, and the idea's zero there means nothing. Every channel
 * carries its own control verdict, because failures are rarely global — a
 * missing PatentsView key takes out patents while news keeps working.
 *
 * The output leads with a readable flag saying, in a sentence, whether the
 * zeros can be believed.
 *
 * ## What this deliberately does not include
 *
 * There is no LinkedIn adapter and there should not be one. No API exposes the
 * data, the terms of service prohibit scraping it, and the anti-bot measures
 * make any scraper unreliable in a way that would silently degrade the control
 * — a channel that quietly stops working is worse here than a channel that
 * does not exist, because the control can only catch what it can measure.
 */

import type { HttpDeps, HttpOptions } from './http.js';
import { searchLiterature } from './search.js';
import { searchNews } from './sources/gdelt.js';
import { searchHackerNews } from './sources/hackernews.js';
import { searchClearances, searchApprovals } from './sources/openfda.js';
import { searchPatents } from './sources/patentsview.js';
import { searchPages } from './sources/wikipedia.js';

export type OccupancyChannel = 'literature' | 'patents' | 'companies' | 'consortia' | 'regulators' | 'news';

export const OCCUPANCY_CHANNELS: readonly OccupancyChannel[] = [
  'literature',
  'patents',
  'companies',
  'consortia',
  'regulators',
  'news',
] as const;

/** Terms appended to locate organizations rather than the technology itself. */
const CONSORTIUM_TERMS = ['consortium', 'alliance', 'standards', 'working group'];

export interface OccupancySample {
  title: string;
  url: string;
  date?: string;
  detail?: string;
}

export interface ChannelResult {
  channel: OccupancyChannel;
  idea_hits: number;
  control_hits: number;
  /** The control found what it was supposed to find, so this channel works. */
  control_passed: boolean;
  /**
   * Whether this channel's idea count can be believed. A non-zero count is
   * always interpretable — something was found, and finding things is not
   * something a broken channel does. A zero is interpretable only if the
   * control passed.
   */
  interpretable: boolean;
  verdict: string;
  samples: OccupancySample[];
  error?: string;
  warning?: string;
}

export interface FindIncumbentsInput {
  idea_terms: string[];
  /** A category known to be occupied. Required — see the module note. */
  control_terms: string[];
  channels?: OccupancyChannel[];
  max_per_channel?: number;
}

export interface FindIncumbentsOutput {
  idea_terms: string[];
  control_terms: string[];
  /** Read this first: one sentence on whether the zeros below mean anything. */
  flag: string;
  control: {
    passed: boolean;
    channels_passed: number;
    channels_total: number;
    failed_channels: OccupancyChannel[];
  };
  occupancy: {
    occupied_channels: OccupancyChannel[];
    empty_and_interpretable: OccupancyChannel[];
    uninterpretable: OccupancyChannel[];
    total_hits: number;
  };
  channels: ChannelResult[];
  warning?: string;
  error?: string;
}

const DEFAULT_MAX = 15;

interface RawChannelRun {
  hits: number;
  samples: OccupancySample[];
  error?: string;
  warning?: string;
}

async function runChannel(
  channel: OccupancyChannel,
  terms: string[],
  max: number,
  options: HttpOptions,
  deps: HttpDeps,
): Promise<RawChannelRun> {
  switch (channel) {
    case 'literature': {
      const result = await searchLiterature({ terms, max_per_source: max }, options, deps);
      return {
        hits: result.results.length,
        samples: result.results.slice(0, 5).map((p) => ({
          title: p.title,
          url: p.url,
          ...(p.published === '' ? {} : { date: p.published }),
          ...(p.venue === undefined ? {} : { detail: p.venue }),
        })),
        ...(result.errors === undefined ? {} : { error: Object.values(result.errors).join('; ') }),
      };
    }

    case 'patents': {
      const result = await searchPatents({ text: terms.join(' '), limit: max }, options, deps);
      return {
        hits: result.records.length,
        samples: result.records.slice(0, 5).map((r) => ({
          title: r.title,
          url: r.url,
          ...(r.grant_date === undefined ? {} : { date: r.grant_date }),
          ...(r.assignees.length === 0 ? {} : { detail: r.assignees.join(', ') }),
        })),
        ...(result.error === undefined ? {} : { error: result.error }),
        // A credential skip is not a channel failure to hide — the control
        // will fail here too, which is exactly the right outcome.
        ...(result.warning === undefined ? {} : { warning: result.warning }),
      };
    }

    case 'companies': {
      const result = await searchHackerNews({ terms, hitsPerPage: max }, options, deps);
      return {
        hits: result.stories.length,
        samples: result.stories.slice(0, 5).map((s) => ({
          title: s.title,
          url: s.url,
          ...(s.created === '' ? {} : { date: s.created }),
          ...(s.points === undefined ? {} : { detail: `${s.points} points` }),
        })),
        ...(result.error === undefined ? {} : { error: result.error }),
        warning:
          'Hacker News over-indexes English-language software startups and under-indexes everything else. ' +
          'Treat a zero here as weak evidence even when the control passes.',
      };
    }

    case 'consortia': {
      const result = await searchPages([...terms, ...CONSORTIUM_TERMS].join(' '), max, options, deps);
      return {
        hits: result.titles.length,
        samples: result.titles.slice(0, 5).map((title) => ({
          title,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        })),
        ...(result.error === undefined ? {} : { error: result.error }),
        warning:
          'Wikipedia is tertiary (§4) and only covers consortia notable enough to have an article. ' +
          'Absence here is weak evidence of absence in the world.',
      };
    }

    case 'regulators': {
      const query = { query: terms.join(' '), limit: max };
      const [clearances, approvals] = [
        await searchClearances(query, options, deps),
        await searchApprovals(query, options, deps),
      ];
      const records = [...clearances.records, ...approvals.records];
      const errors = [clearances.error, approvals.error].filter((e) => e !== undefined);
      return {
        hits: records.length,
        samples: records.slice(0, 5).map((r) => ({
          title: r.device_name ?? r.title,
          url: r.url,
          ...(r.date === undefined ? {} : { date: r.date }),
          ...(r.applicant === undefined ? {} : { detail: r.applicant }),
        })),
        ...(errors.length === 0 ? {} : { error: errors.join('; ') }),
        warning:
          'openFDA covers US medical devices only. For a non-medical idea this channel is not merely empty, ' +
          'it is inapplicable — and the control will show that by failing too.',
      };
    }

    case 'news': {
      const result = await searchNews({ terms, maxRecords: max }, options, deps);
      return {
        hits: result.articles.length,
        samples: result.articles.slice(0, 5).map((a) => ({
          title: a.title,
          url: a.url,
          ...(a.seen === '' ? {} : { date: a.seen }),
          detail: a.domain,
        })),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }

    default:
      return { hits: 0, samples: [], error: `Unknown channel: ${String(channel)}` };
  }
}

function verdictFor(idea: RawChannelRun, control: RawChannelRun, controlPassed: boolean): string {
  if (idea.error !== undefined) {
    return `Channel errored (${idea.error}). No conclusion is available: this is not an absence of incumbents.`;
  }
  if (idea.hits > 0) {
    return `${idea.hits} hit(s) — this channel is OCCUPIED. Occupancy stands regardless of the control, since a broken channel does not invent results.`;
  }
  if (controlPassed) {
    return `No hits, and the control returned ${control.hits} — the channel works, so this zero is real evidence of absence in this channel.`;
  }
  return (
    `No hits, but the control ALSO returned nothing${control.error === undefined ? '' : ` (${control.error})`}. ` +
    'This channel is broken, blocked, or inapplicable, so its zero means nothing. Do not read it as absence.'
  );
}

export async function findIncumbents(
  input: FindIncumbentsInput,
  options: HttpOptions = {},
  deps: HttpDeps = {},
): Promise<FindIncumbentsOutput> {
  const ideaTerms = input.idea_terms.map((t) => t.trim()).filter((t) => t !== '');
  const controlTerms = input.control_terms.map((t) => t.trim()).filter((t) => t !== '');
  const channels = input.channels ?? OCCUPANCY_CHANNELS;
  const max = input.max_per_channel ?? DEFAULT_MAX;

  const empty = {
    idea_terms: ideaTerms,
    control_terms: controlTerms,
    control: { passed: false, channels_passed: 0, channels_total: 0, failed_channels: [] as OccupancyChannel[] },
    occupancy: {
      occupied_channels: [] as OccupancyChannel[],
      empty_and_interpretable: [] as OccupancyChannel[],
      uninterpretable: [] as OccupancyChannel[],
      total_hits: 0,
    },
    channels: [] as ChannelResult[],
  };

  if (ideaTerms.length === 0) {
    return { ...empty, flag: 'No idea terms supplied; nothing was searched.', error: 'idea_terms is empty.' };
  }
  if (controlTerms.length === 0) {
    // Refusing here rather than sweeping anyway is the point of the tool: an
    // uncontrolled sweep produces a number that cannot be interpreted, and
    // returning one would invite exactly the misreading this guards against.
    return {
      ...empty,
      flag: 'No control terms supplied, so no zero from this sweep could be interpreted. Nothing was searched.',
      error:
        'control_terms is required. Supply a category you already know is occupied; without it, an empty result ' +
        'is indistinguishable from a broken search.',
    };
  }

  const results: ChannelResult[] = [];
  for (const channel of channels) {
    // The control runs through the same code path as the idea, not a
    // simplified one — a control that exercises a different path proves
    // nothing about the path that produced the zero.
    const idea = await runChannel(channel, ideaTerms, max, options, deps);
    const control = await runChannel(channel, controlTerms, max, options, deps);

    const controlPassed = control.hits > 0 && control.error === undefined;
    const interpretable = idea.error === undefined && (idea.hits > 0 || controlPassed);

    const warnings = [idea.warning, control.warning === idea.warning ? undefined : control.warning].filter(
      (w): w is string => w !== undefined,
    );

    results.push({
      channel,
      idea_hits: idea.hits,
      control_hits: control.hits,
      control_passed: controlPassed,
      interpretable,
      verdict: verdictFor(idea, control, controlPassed),
      samples: idea.samples,
      ...(idea.error === undefined ? {} : { error: idea.error }),
      ...(warnings.length === 0 ? {} : { warning: warnings.join(' ') }),
    });
  }

  const occupied = results.filter((r) => r.idea_hits > 0).map((r) => r.channel);
  const emptyInterpretable = results.filter((r) => r.idea_hits === 0 && r.interpretable).map((r) => r.channel);
  const uninterpretable = results.filter((r) => !r.interpretable).map((r) => r.channel);
  const failed = results.filter((r) => !r.control_passed).map((r) => r.channel);
  const totalHits = results.reduce((sum, r) => sum + r.idea_hits, 0);
  const passedCount = results.length - failed.length;

  let flag: string;
  if (occupied.length > 0) {
    flag =
      `OCCUPIED: ${totalHits} hit(s) across ${occupied.length} of ${results.length} channels (${occupied.join(', ')}). ` +
      `The control passed in ${passedCount}/${results.length} channels. Occupancy is established regardless of the ` +
      'control, since a failing channel returns nothing rather than inventing results.';
  } else if (uninterpretable.length === results.length) {
    flag =
      `NOT INTERPRETABLE: no hits anywhere, and the control failed in EVERY channel (${failed.join(', ')}). ` +
      'The sweep did not work. This is not evidence that the idea is unoccupied — it is no evidence at all.';
  } else if (uninterpretable.length > 0) {
    flag =
      `PARTIAL: no hits for the idea. The control passed in ${passedCount}/${results.length} channels, so the zeros ` +
      `in ${emptyInterpretable.join(', ')} are real; the zeros in ${uninterpretable.join(', ')} are not interpretable ` +
      'because the control failed there too.';
  } else {
    flag =
      `APPARENTLY UNOCCUPIED: no hits for the idea in any of ${results.length} channels, and the control returned ` +
      'results in all of them. The sweep worked and found nothing — the strongest negative this tool can produce. ' +
      'It remains evidence of absence in these channels, not proof of absence in the world.';
  }

  const notes: string[] = [];
  if (failed.length > 0 && occupied.length === 0) {
    notes.push(`Control failed in: ${failed.join(', ')}. Fix or exclude those channels before trusting their zeros.`);
  }
  notes.push(
    'No LinkedIn channel by design: no API exposes the data, the terms prohibit scraping, and the anti-bot ' +
      'measures would make the channel fail intermittently — which the control could not reliably catch.',
  );

  return {
    idea_terms: ideaTerms,
    control_terms: controlTerms,
    flag,
    control: {
      passed: failed.length === 0,
      channels_passed: passedCount,
      channels_total: results.length,
      failed_channels: failed,
    },
    occupancy: {
      occupied_channels: occupied,
      empty_and_interpretable: emptyInterpretable,
      uninterpretable,
      total_hits: totalHits,
    },
    channels: results,
    ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
  };
}
