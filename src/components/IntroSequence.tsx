import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, SkipForward, Volume2, VolumeX } from 'lucide-react';
import { Button } from '../design';

/*
 * The intro film.
 *
 * A splash screen is a tax on every visit, so this one is built around the ways
 * that tax is normally levied unfairly:
 *
 *  - **It is skippable from the first frame**, by click, by Escape, by Enter,
 *    and by a focusable button — not by a 4px "skip" in a corner that appears
 *    after six seconds.
 *  - **It plays once.** A returning visitor goes straight to the launch page.
 *    An intro you cannot get past on the fifth visit is the reason people
 *    bookmark deep links.
 *  - **It is muted by default.** Autoplay with sound is blocked by every modern
 *    browser anyway, so unmuted-by-default means "silently fails to start" on
 *    most machines. Sound is one click away and the control says so.
 *  - **It respects `prefers-reduced-motion`.** A user who has told their
 *    operating system that motion makes them ill is not shown a ten-second
 *    tunnel flythrough; they get the poster frame and the skip.
 *  - **It never traps anyone.** If the video fails to load, fails to decode, or
 *    autoplay is refused, the sequence completes rather than leaving a black
 *    rectangle. That path is the one most likely to be hit and least likely to
 *    be tested, so it is the default rather than the fallback.
 *
 * The dissolve out is CSS opacity on the whole layer, timed to the same
 * duration token the rest of the system uses.
 */

const SEEN_KEY = 'v12_intro_seen';
const FADE_MS = 900;

interface Props {
  /** Called once the sequence is finished, skipped or has failed to start. */
  onComplete: () => void;
  /** Ignore the "already seen" flag — used by the replay control. */
  force?: boolean;
}

export const hasSeenIntro = (): boolean => {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // Private browsing, blocked storage, embedded webview. Treat as unseen and
    // let it play — better than throwing on the first line of the app.
    return false;
  }
};

export const markIntroSeen = (): void => {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* nothing to do; the intro simply plays again next time */
  }
};

export const IntroSequence: React.FC<Props> = ({ onComplete, force = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fading, setFading] = useState(false);
  const [muted, setMuted] = useState(true);
  const [needsGesture, setNeedsGesture] = useState(false);
  const finished = useRef(false);

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    markIntroSeen();
    setFading(true);
    window.setTimeout(onComplete, FADE_MS);
  }, [onComplete]);

  // Escape and Enter both end it. Escape because that is what Escape means;
  // Enter because a keyboard user's hand is already there.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        finish();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [finish]);

  /*
   * Mount-only. The dependency array is deliberately empty.
   *
   * `finish` is a `useCallback` over `onComplete`, which arrives as an inline
   * arrow from the parent and therefore has a new identity on every render. With
   * `[finish]` in the deps this effect re-ran constantly: `video.play()` was
   * called again on each render and the 16-second guard was torn down and
   * rebuilt before it could ever fire. The ref below carries the current
   * `finish` so the effect can stay mounted-once and still call the latest one.
   */
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (reducedMotion) return;

    const video = videoRef.current;
    if (!video) return;

    // A rejected autoplay promise is a normal, expected outcome — not an error
    // to log and forget. Offer a play control instead of a dead frame.
    const attempt = video.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => setNeedsGesture(true));
    }

    // Belt and braces: if the video never fires `ended` — a codec the browser
    // silently refuses, a truncated download — the sequence still completes.
    const guard = window.setTimeout(() => finishRef.current(), 16_000);
    return () => window.clearTimeout(guard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="V12 Apex Atlas introduction"
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      style={{
        background: 'var(--surface-0)',
        opacity: fading ? 0 : 1,
        transition: `opacity ${FADE_MS}ms var(--ease-out)`,
      }}
      onClick={finish}
    >
      {reducedMotion ? (
        // The poster, held. Same frame, no motion, same skip affordance.
        <img
          src="/media/intro-poster.jpg"
          alt="V12 Apex Atlas"
          className="max-h-full max-w-full object-contain"
        />
      ) : (
        <video
          ref={videoRef}
          className="max-h-full max-w-full object-contain"
          poster="/media/intro-poster.jpg"
          muted={muted}
          playsInline
          preload="auto"
          onEnded={finish}
          /*
           * NOT a plain `onError={finish}`.
           *
           * With two <source> children, React delivers the *first* source's
           * error here — and on a browser without H.264 that fires while the
           * WebM fallback is still loading perfectly well. Ending the sequence
           * on it meant the film was skipped on exactly the browsers the
           * fallback exists to serve.
           *
           * So this asks the element whether it actually failed: an error is
           * fatal only when the video itself is in an error state with nothing
           * decoded. Anything else is a source being tried and discarded, which
           * is the mechanism working.
           */
          onError={() => {
            const video = videoRef.current;
            if (!video) return finish();
            window.setTimeout(() => {
              const el = videoRef.current;
              if (!el) return;
              if (el.error && el.readyState === 0) finish();
            }, 400);
          }}
        >
          {/*
            Two sources, because H.264 is not universal. Chromium builds
            compiled without proprietary codecs — several Linux distributions,
            and the Chromium bundled with Playwright — cannot decode it, and
            fall through to the next source. VP9 is royalty-free and present in
            all of them. Found by screenshotting this component in headless
            Chromium and getting the launch page instead of the film.
          */}
          <source src="/media/intro.mp4" type="video/mp4" />
          <source src="/media/intro.webm" type="video/webm" />
        </video>
      )}

      {/* A vignette that ties the video into the app surface rather than
          leaving it as a rectangle pasted on black. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at center, transparent 55%, color-mix(in srgb, var(--surface-0) 92%, transparent) 100%)',
        }}
      />

      {needsGesture && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setNeedsGesture(false);
            void videoRef.current?.play().catch(finish);
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 cursor-pointer"
          style={{ background: 'color-mix(in srgb, var(--surface-0) 70%, transparent)' }}
        >
          <Play className="w-12 h-12" style={{ color: 'var(--accent)' }} aria-hidden="true" />
          <span className="text-xs" style={{ color: 'var(--ink-secondary)' }}>
            Play the introduction
          </span>
        </button>
      )}

      <div className="absolute bottom-6 right-6 flex items-center gap-2">
        {!reducedMotion && (
          <Button
            size="sm"
            variant="ghost"
            icon={
              muted ? (
                <VolumeX className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
              )
            }
            aria-label={muted ? 'Unmute the introduction' : 'Mute the introduction'}
            onClick={(event) => {
              event.stopPropagation();
              setMuted((m) => !m);
            }}
          >
            {muted ? 'Sound' : 'Mute'}
          </Button>
        )}

        <Button
          size="sm"
          variant="secondary"
          icon={<SkipForward className="w-3.5 h-3.5" aria-hidden="true" />}
          onClick={(event) => {
            event.stopPropagation();
            finish();
          }}
        >
          Skip
        </Button>
      </div>

      <p
        className="absolute bottom-7 left-6 text-[10px] tracking-widest uppercase"
        style={{ color: 'var(--ink-muted)' }}
      >
        Urban Visions Enterprises
      </p>
    </div>
  );
};
