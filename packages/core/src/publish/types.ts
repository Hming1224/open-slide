export type PublishStatus = 'idle' | 'publishing' | 'live' | 'failed';

export type SlidePublishState = {
  slideId: string;
  autoPublish: boolean;
  dirty: boolean;
  dirtyVersion: number;
  projectName: string;
  team: string;
  publicUrl: string | null;
  previewUrl: string | null;
  status: PublishStatus;
  lastCheckedAt: string | null;
  lastPublishedAt: string | null;
  lastArtifactHash: string | null;
  error: string | null;
};

export type PublishSettingsInput = {
  autoPublish?: boolean;
  projectName?: string;
  team?: string;
};

export type PublishResult = {
  state: SlidePublishState;
  outcome: 'published' | 'unchanged';
};
