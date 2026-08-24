import React from 'react';
import { ArrowRight, Boxes, Eye, KeyRound, PlayCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { Alert, Button, GlassPanel } from '../design';

/*
 * The launch page — what the intro dissolves into.
 *
 * Two jobs and no others: get an invited person signed up, and let an uninvited
 * one look around. Everything on this page serves one of those.
 *
 * It is deliberately honest about being a closed beta. A landing page that
 * hides the invite requirement until after someone has filled in a form is how
 * you turn interest into irritation, and the people arriving here have a code
 * in their hand already.
 *
 * A note on indexing: the application host carries `noindex` and `robots.txt`
 * disallows everything, on purpose — indexing an app host is how customer
 * subdomains reach search results. That policy is unchanged by this page. When
 * there is public marketing to rank, it belongs on its own host.
 */

interface Props {
  onSignUp: () => void;
  onSignIn: () => void;
  /** Continue into the workspace unauthenticated — read-only demo data. */
  onExplore: () => void;
  onReplayIntro: () => void;
}

const PILLARS = [
  {
    icon: Boxes,
    title: 'A twin your agents can act on',
    body: 'Production lines, warehouses and inventory live as markdown with frontmatter. Edit a file, and what the boardroom computes changes with it.',
  },
  {
    icon: ShieldCheck,
    title: 'The mandate is code, not a prompt',
    body: 'The zero-loss rule is enforced server-side, net of both fee legs. Mark a production line degraded and acquisition of what it makes stops — in the same request.',
  },
  {
    icon: Sparkles,
    title: 'Generated UI that cannot reach you',
    body: 'Agents render interfaces into an opaque-origin sandbox with no cookies, no storage and no network. The worst a hostile artifact can do is draw the wrong pixels.',
  },
];

export const LaunchPage: React.FC<Props> = ({ onSignUp, onSignIn, onExplore, onReplayIntro }) => (
  <div
    className="min-h-screen w-full overflow-y-auto"
    style={{ background: 'var(--surface-0)', color: 'var(--ink-primary)' }}
  >
    {/* Ambient field — the same cyan the film resolves to, so the dissolve
        lands somewhere that looks related rather than on a flat page. */}
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0"
      style={{
        background:
          'radial-gradient(1100px 620px at 50% -12%, color-mix(in srgb, var(--series-1) 16%, transparent), transparent 62%),' +
          'radial-gradient(760px 420px at 88% 8%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 60%)',
      }}
    />

    <div className="relative mx-auto max-w-5xl px-6 py-14 md:py-20">
      {/* ------------------------------------------------------------ mark */}
      <header className="flex flex-col items-center text-center">
        <img
          src="/media/logo-reverse-512.png"
          alt="Urban Visions Enterprises — V12 Multimedia"
          width={232}
          height={267}
          className="mb-7 w-[168px] md:w-[232px] h-auto"
          // Above the fold and the largest paint on the page: eager, and
          // high-priority so it is not queued behind the video.
          loading="eager"
          decoding="sync"
        />

        <p
          className="text-[11px] uppercase tracking-[0.32em] mb-3"
          style={{ color: 'var(--ink-muted)' }}
        >
          Urban Visions Enterprises
        </p>

        <h1 className="text-3xl md:text-5xl font-semibold leading-tight max-w-3xl">
          V12 Apex Atlas
        </h1>

        <p
          className="mt-4 text-sm md:text-base max-w-2xl leading-relaxed"
          style={{ color: 'var(--ink-secondary)' }}
        >
          An agentic operations workspace for multimedia production. A digital twin of your production
          and logistics network, a zero-loss settlement engine over the inventory it holds, and a
          hash-chained record of every decision — including the refusals.
        </p>

        {/* --------------------------------------------------------- actions */}
        <div className="mt-9 flex flex-col sm:flex-row items-center gap-3">
          <Button
            variant="primary"
            icon={<KeyRound className="w-4 h-4" aria-hidden="true" />}
            onClick={onSignUp}
          >
            Redeem an invite
          </Button>
          <Button variant="secondary" onClick={onSignIn}>
            Sign in
          </Button>
          <Button
            variant="ghost"
            icon={<Eye className="w-4 h-4" aria-hidden="true" />}
            onClick={onExplore}
          >
            Look around first
          </Button>
        </div>

        <div className="mt-6 w-full max-w-xl">
          <Alert role="info" title="Closed beta." live="none">
            Registration needs an invite code. &ldquo;Look around&rdquo; opens the workspace on a shared
            demo book — real software, sample data, nothing to sign.
          </Alert>
        </div>
      </header>

      {/* --------------------------------------------------------- pillars */}
      <section className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-4" aria-label="What it does">
        {PILLARS.map(({ icon: Icon, title, body }) => (
          <GlassPanel key={title} as="article">
            <Icon className="w-5 h-5 mb-3" style={{ color: 'var(--accent)' }} aria-hidden="true" />
            <h2 className="text-sm font-semibold mb-1.5">{title}</h2>
            <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
              {body}
            </p>
          </GlassPanel>
        ))}
      </section>

      {/* ------------------------------------------------------------ still */}
      <section className="mt-14">
        <GlassPanel padded={false} className="overflow-hidden">
          <img
            src="/media/intro-still.jpg"
            alt=""
            className="w-full h-auto opacity-90"
            loading="lazy"
            decoding="async"
          />
          <div className="p-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
              Missed the introduction?
            </p>
            <Button
              size="sm"
              variant="ghost"
              icon={<PlayCircle className="w-3.5 h-3.5" aria-hidden="true" />}
              onClick={onReplayIntro}
            >
              Play it again
            </Button>
          </div>
        </GlassPanel>
      </section>

      {/* ------------------------------------------------------------ honest */}
      <section className="mt-14">
        <GlassPanel>
          <h2 className="text-sm font-semibold mb-2">What is actually built</h2>
          <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
            Eight modules over a hardened spine: authentication and roles, tenant isolation enforced by
            the type system, the hash-chained audit log, the sandboxed generative-UI harness, the Hermes
            mandate engine, the digital twin and its validator, and the asset ledger. Bids come from an
            internal marketplace model, not from live counterparties, and every surface that shows one
            says so.
          </p>
          <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            Not built yet: the agent factory, the workflow builder, mission control, analytics and
            billing. This is a beta, and you are being invited to shape what those become.
          </p>
        </GlassPanel>
      </section>

      <footer
        className="mt-14 flex flex-wrap items-center justify-between gap-3 text-[11px]"
        style={{ color: 'var(--ink-muted)' }}
      >
        <span>© {new Date().getFullYear()} Urban Visions Enterprises · V12 Multimedia</span>
        <button
          type="button"
          onClick={onExplore}
          className="inline-flex items-center gap-1 cursor-pointer hover:underline"
        >
          Continue to the workspace
          <ArrowRight className="w-3 h-3" aria-hidden="true" />
        </button>
      </footer>
    </div>
  </div>
);
