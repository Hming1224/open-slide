import { Check, Copy, ExternalLink, Loader2, RefreshCw, Rocket } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLocale } from '@/lib/use-locale';
import type { PublishResult, SlidePublishState } from '../../publish/types';
import { createSlideHtmlArchive } from '../lib/export-html';
import type { SlideModule } from '../lib/sdk';

const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1000;

type PublishDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slide: SlideModule;
  slideId: string;
};

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `request failed (${response.status})`);
  return body;
}

export function PublishDialog({ open, onOpenChange, slide, slideId }: PublishDialogProps) {
  const t = useLocale();
  const [state, setState] = useState<SlidePublishState | null>(null);
  const [projectName, setProjectName] = useState('');
  const [team, setTeam] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const loadState = useCallback(async () => {
    const response = await fetch(`/__publish/${encodeURIComponent(slideId)}`, {
      cache: 'no-store',
    });
    const next = await responseJson<SlidePublishState>(response);
    setState(next);
    setProjectName(next.projectName);
    setTeam(next.team);
    return next;
  }, [slideId]);

  const saveSettings = useCallback(
    async (settings: { autoPublish?: boolean; projectName?: string; team?: string }) => {
      const response = await fetch(`/__publish/${encodeURIComponent(slideId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const next = await responseJson<SlidePublishState>(response);
      setState(next);
      setProjectName(next.projectName);
      setTeam(next.team);
      return next;
    },
    [slideId],
  );

  const publish = useCallback(
    async (automatic = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        if (!automatic) {
          await saveSettings({ projectName: projectName.trim(), team: team.trim() });
        }
        const archive = await createSlideHtmlArchive(slide, slideId, true);
        if (!archive) throw new Error(t.slide.publishEmptySlide);
        const response = await fetch(`/__publish/${encodeURIComponent(slideId)}/deploy`, {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: archive.bytes as BodyInit,
        });
        const result = await responseJson<PublishResult>(response);
        setState(result.state);
        setProjectName(result.state.projectName);
        setTeam(result.state.team);
        if (!automatic) {
          toast.success(
            result.outcome === 'published' ? t.slide.publishSuccess : t.slide.publishNoChanges,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : t.slide.publishFailed;
        if (!automatic) toast.error(message, { duration: 6000 });
        await loadState().catch(() => {});
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [loadState, projectName, saveSettings, slide, slideId, t, team],
  );

  const checkForAutoPublish = useCallback(async () => {
    if (busyRef.current) return;
    try {
      const latest = await loadState();
      if (latest.autoPublish) await publish(true);
    } catch (err) {
      console.error('[open-slide] automatic publish check failed', err);
    }
  }, [loadState, publish]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!import.meta.hot) return;
    const markDirty = () => {
      void fetch(`/__publish/${encodeURIComponent(slideId)}/dirty`, { method: 'POST' })
        .then((response) => responseJson<SlidePublishState>(response))
        .then(setState)
        .catch((err) => console.error('[open-slide] could not mark publish state dirty', err));
    };
    import.meta.hot.on('vite:beforeUpdate', markDirty);
    return () => import.meta.hot?.off('vite:beforeUpdate', markDirty);
  }, [slideId]);

  useEffect(() => {
    const initial = setTimeout(async () => {
      try {
        const latest = await loadState();
        if (latest.autoPublish) await publish(true);
      } catch (err) {
        console.error('[open-slide] startup publish check failed', err);
      }
    }, 5000);
    const interval = setInterval(() => void checkForAutoPublish(), AUTO_CHECK_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [checkForAutoPublish, loadState, publish]);

  const copyPublicLink = async () => {
    if (!state?.publicUrl) return;
    await navigator.clipboard.writeText(state.publicUrl);
    toast.success(t.slide.publishLinkCopied);
  };

  const lastActivity = state?.lastPublishedAt ?? state?.lastCheckedAt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket className="size-4 text-brand" />
            {t.slide.publishTitle}
          </DialogTitle>
          <DialogDescription>{t.slide.publishDescription}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="publish-project">{t.slide.publishProject}</Label>
            <Input
              id="publish-project"
              value={projectName}
              disabled={busy}
              onChange={(event) => setProjectName(event.target.value.toLowerCase())}
              placeholder="my-presentation"
            />
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              {t.slide.publishProjectHint}
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="publish-team">{t.slide.publishTeam}</Label>
            <Input
              id="publish-team"
              value={team}
              disabled={busy}
              onChange={(event) => setTeam(event.target.value)}
              placeholder={t.slide.publishTeamPlaceholder}
            />
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-[7px] border border-border bg-muted/35 p-3">
            <input
              type="checkbox"
              className="mt-0.5 size-4 accent-[var(--brand)]"
              checked={state?.autoPublish ?? false}
              disabled={!state || busy}
              onChange={(event) => {
                void saveSettings({
                  autoPublish: event.target.checked,
                  projectName: projectName.trim(),
                  team: team.trim(),
                }).catch((err) => toast.error(String(err instanceof Error ? err.message : err)));
              }}
            />
            <span className="grid gap-1">
              <span className="text-[13px] font-medium">{t.slide.publishAuto}</span>
              <span className="text-[11.5px] leading-relaxed text-muted-foreground">
                {t.slide.publishAutoHint}
              </span>
            </span>
          </label>

          {state?.publicUrl && (
            <div className="grid gap-2 rounded-[7px] border border-border bg-card p-3">
              <div className="flex items-center gap-2 text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
                <Check className="size-3.5" />
                {state.dirty ? t.slide.publishChangesPending : t.slide.publishLive}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-[5px] bg-muted px-2 py-1.5 text-[11.5px]">
                  {state.publicUrl}
                </code>
                <Button size="icon-sm" variant="outline" onClick={copyPublicLink}>
                  <Copy />
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() =>
                    window.open(state.publicUrl ?? '', '_blank', 'noopener,noreferrer')
                  }
                >
                  <ExternalLink />
                </Button>
              </div>
            </div>
          )}

          {state?.error && (
            <p className="rounded-[6px] bg-destructive/10 px-3 py-2 text-[11.5px] leading-relaxed text-destructive">
              {state.error}
            </p>
          )}

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>
              {state?.dirty ? t.slide.publishChangesPending : t.slide.publishNoPendingChanges}
            </span>
            {lastActivity && <span>{new Date(lastActivity).toLocaleString()}</span>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void checkForAutoPublish()}>
            <RefreshCw className={busy ? 'animate-spin' : ''} />
            {t.slide.publishCheckNow}
          </Button>
          <Button disabled={busy || !projectName.trim()} onClick={() => void publish(false)}>
            {busy ? <Loader2 className="animate-spin" /> : <Rocket />}
            {busy ? t.slide.publishing : t.slide.publishNow}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
