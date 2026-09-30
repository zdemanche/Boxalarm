import { radius, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, useTheme, type SurfaceTheme } from '../../components/ui';
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type {
  ChecklistItem,
  ChecklistTemplate,
  DefectSeverity,
  ItemResult,
} from '../../features/checks/types';
import { ApiError } from '../../lib/apiClient';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { DeliveryStatus } from '../../sync/DeliveryStatus';
import { kvDelete, kvGet, kvSet } from '../../sync/kvStore';
import { capturePhoto } from '../../sync/photoCapture';
import { formatAsOf, NoCachedDataError } from '../../sync/readThrough';
import { useOutboxItem } from '../../sync/useOutboxItem';

function newIdempotencyKey(): string {
  return `check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// docs/design.md §8.4 severity words, mapped onto the defect API's enum.
export const SEVERITY_OPTIONS: { value: DefectSeverity; label: string }[] = [
  { value: 'MINOR', label: 'Note' },
  { value: 'MAJOR', label: 'Affects service' },
  { value: 'OUT_OF_SERVICE', label: 'Out of service now' },
];
const SEVERITY_LABEL = Object.fromEntries(
  SEVERITY_OPTIONS.map((o) => [o.value, o.label]),
) as Record<DefectSeverity, string>;
// A failed item is a defect that affects service until someone says otherwise.
const DEFAULT_SEVERITY: DefectSeverity = 'MAJOR';

/** A check in progress older than this is not offered back (design.md §11.2: retained 24 h). */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CheckDraft {
  readonly templateId: string;
  readonly startedAt: number;
  readonly idempotencyKey: string;
  readonly results: Record<string, boolean>;
  readonly severities: Record<string, DefectSeverity>;
  readonly notes: Record<string, string>;
  readonly photos: Record<string, boolean>;
}

interface CompletedSummary {
  readonly passed: number;
  readonly defects: { label: string; severity: DefectSeverity }[];
  readonly durationSeconds: number;
}

/** The description the apparatus officer reads: which unit, which item, and the member's note. */
export function defectDescription(unitId: string, item: ChecklistItem, note: string): string {
  const base = `Failed on the ${unitId} truck check: ${item.label}.`;
  return note.trim() ? `${base} ${note.trim()}` : base;
}

// N4.2: no step waits on a network round trip. Every answer is a local state update, journaled to
// this phone (kvStore) as it is made so a phone call, backgrounding or an OS kill loses nothing;
// "Submit check" writes the run - and one defect per failed item - to the local outbox.
export function CheckRunnerScreen() {
  const route = useRoute();
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const apparatusId = (route.params as { apparatusId: string }).apparatusId;
  const theme = useTheme();
  const auth = useOptionalAuth();
  const repository = useChecksRepository();
  const { isOnline } = useOptionalConnectivity();
  const draftKey = `check-draft:${auth?.memberId ?? 'anon'}:${apparatusId}`;

  const [template, setTemplate] = useState<ChecklistTemplate | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateAttempt, setTemplateAttempt] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [severities, setSeverities] = useState<Record<string, DefectSeverity>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [photosCaptured, setPhotosCaptured] = useState<Record<string, boolean>>({});
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [restoredFrom, setRestoredFrom] = useState<number | null>(null);
  const [completed, setCompleted] = useState<CompletedSummary | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const lastProgressAnnouncement = useRef(0);

  const handleAddPhoto = async (code: string) => {
    setPhotoError(null);
    const result = await capturePhoto();
    if (result.status === 'captured') {
      setPhotosCaptured((prev) => ({ ...prev, [code]: true }));
    } else if (result.status === 'error') {
      // A capture failure must never be silently treated as "no photo needed" - the item stays
      // gated and the crew is told why, instead of guessing at a blank camera result.
      setPhotoError(result.message);
      AccessibilityInfo.announceForAccessibility(`Photo capture failed: ${result.message}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setTemplateError(null);
    // Offline, the repository serves the last real sheet this phone fetched (template.cachedAt);
    // with none cached it throws NoCachedDataError. Real API errors (403/404/5xx) are rethrown -
    // all of these must be shown, not left as a blank screen (PR #321 review M10).
    repository
      .getChecklistTemplate(apparatusId)
      .then(async (result) => {
        if (cancelled) return;
        // Resume a check in progress for this unit and sheet, if the phone has one.
        const draft = await kvGet<CheckDraft>(draftKey);
        if (cancelled) return;
        if (
          draft &&
          draft.value.templateId === result.templateId &&
          Date.now() - draft.updatedAt < DRAFT_MAX_AGE_MS &&
          Object.keys(draft.value.results).length > 0
        ) {
          setResults(draft.value.results);
          setSeverities(draft.value.severities);
          setNotes(draft.value.notes);
          setPhotosCaptured(draft.value.photos);
          setStartedAt(draft.value.startedAt);
          setIdempotencyKey(draft.value.idempotencyKey);
          setRestoredFrom(draft.updatedAt);
          AccessibilityInfo.announceForAccessibility(
            `Restored your check in progress from ${formatAsOf(draft.updatedAt)}.`,
          );
        }
        setTemplate(result);
        setHydrated(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message =
          error instanceof NoCachedDataError
            ? `This phone hasn't loaded the ${apparatusId} check sheet yet. Connect once to download it; after that, the check works without signal.`
            : error instanceof ApiError && error.problem.status === 403
              ? 'You do not have access to this apparatus checklist.'
              : 'The checklist could not be loaded.';
        setTemplateError(message);
        AccessibilityInfo.announceForAccessibility(message);
      });
    return () => {
      cancelled = true;
    };
  }, [apparatusId, repository, templateAttempt, draftKey]);

  // Journal every answer as it is made. Only after hydration, so an empty first render never
  // overwrites a saved check before it has been restored.
  useEffect(() => {
    if (!hydrated || !template || completed) return;
    if (Object.keys(results).length === 0) return;
    const draft: CheckDraft = {
      templateId: template.templateId,
      startedAt,
      idempotencyKey,
      results,
      severities,
      notes,
      photos: photosCaptured,
    };
    void kvSet(draftKey, draft);
  }, [
    hydrated,
    template,
    completed,
    results,
    severities,
    notes,
    photosCaptured,
    startedAt,
    idempotencyKey,
    draftKey,
  ]);

  const answeredCount = template ? template.items.filter((item) => item.code in results).length : 0;
  const total = template?.items.length ?? 0;

  // Progress is announced at most once every 3 s (a11y-spec N9), so a fast run of taps doesn't
  // flood the screen reader.
  useEffect(() => {
    if (!template || answeredCount === 0) return;
    const now = Date.now();
    if (now - lastProgressAnnouncement.current < 3000 && answeredCount < total) return;
    lastProgressAnnouncement.current = now;
    AccessibilityInfo.announceForAccessibility(`${answeredCount} of ${total} checked`);
  }, [answeredCount, total, template]);

  const answer = useCallback((code: string, pass: boolean) => {
    setSubmitError(null);
    setResults((prev) => ({ ...prev, [code]: pass }));
    if (!pass) {
      setSeverities((prev) => (prev[code] ? prev : { ...prev, [code]: DEFAULT_SEVERITY }));
    }
  }, []);

  if (!template && templateError) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: spacing.lg }}>
        <View style={{ flex: 1, justifyContent: 'center', gap: spacing.md }}>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {templateError}
          </Text>
          <Button label="Try again" onPress={() => setTemplateAttempt((n) => n + 1)} />
          <Button
            label="Back to apparatus"
            variant="secondary"
            onPress={() => navigation.goBack()}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (!template) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: theme.bg,
          padding: spacing.lg,
          justifyContent: 'center',
        }}
      >
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`Loading the ${apparatusId} check sheet`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
        >
          <ActivityIndicator color={theme.fg} />
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            Loading the {apparatusId} check sheet…
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (template.items.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: spacing.lg }}>
        <Text style={{ color: theme.fg, fontSize: typeScale.body.size, marginBottom: spacing.md }}>
          This apparatus has no check sheet yet. The apparatus officer sets one up in settings.
        </Text>
        <Button label="Back to apparatus" onPress={() => navigation.goBack()} />
      </SafeAreaView>
    );
  }

  if (completed) {
    return (
      <CompletionView
        unitId={apparatusId}
        summary={completed}
        outboxId={idempotencyKey}
        isOnline={isOnline}
        theme={theme}
        onDone={() => navigation.goBack()}
      />
    );
  }

  const isGated = (item: ChecklistItem) => item.requiresPhoto && !photosCaptured[item.code];
  const unanswered = template.items.filter((item) => !(item.code in results));
  // Bulk OK is for "the rest are fine" after looking at the truck, not a one-tap sign-off: it
  // appears only once at least one item has been answered, and never covers photo-gated or
  // critical items (review m1).
  const markableAsOk =
    answeredCount === 0
      ? []
      : unanswered.filter((item) => !isGated(item) && item.critical !== true);

  const markRestOk = () => {
    setSubmitError(null);
    setResults((prev) => {
      const next = { ...prev };
      for (const item of markableAsOk) next[item.code] = true;
      return next;
    });
    AccessibilityInfo.announceForAccessibility(
      `${markableAsOk.length} items marked Pass. ${total - unanswered.length + markableAsOk.length} of ${total} checked.`,
    );
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (unanswered.length > 0) {
      const message = `Answer ${unanswered.length} more ${
        unanswered.length === 1 ? 'item' : 'items'
      } before submitting: ${unanswered.map((item) => item.label).join(', ')}.`;
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    const itemResults: ItemResult[] = template.items.map((item) => {
      const note = notes[item.code]?.trim();
      return {
        code: item.code,
        pass: results[item.code] ?? false,
        ...(note ? { note } : {}),
      };
    });
    const failedItems = template.items.filter((item) => results[item.code] === false);
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Signed in, each of these is a local outbox enqueue (no network round trip). The run and
      // every defect reuse keys derived from this check's idempotencyKey, so a retry after a
      // partial failure can't double-submit either.
      await repository.submitChecklistRun({
        apparatusId,
        templateId: template.templateId,
        durationSeconds,
        itemResults,
        idempotencyKey,
        capturedOffline: !isOnline,
      });
      // A failed item has to reach the apparatus officer: each becomes a defect report through
      // the existing defect API, pre-filled with the unit and item, so nothing is typed twice.
      for (const item of failedItems) {
        await repository.submitDefect({
          apparatusId,
          description: defectDescription(apparatusId, item, notes[item.code] ?? ''),
          severity: severities[item.code] ?? DEFAULT_SEVERITY,
          idempotencyKey: `${idempotencyKey}-defect-${item.code}`,
        });
      }
    } catch {
      const message =
        'The check could not be saved on this device. Your answers are still here. Try again.';
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
      setSubmitting(false);
      return;
    }
    await kvDelete(draftKey);
    setSubmitting(false);
    setCompleted({
      passed: template.items.length - failedItems.length,
      defects: failedItems.map((item) => ({
        label: item.label,
        severity: severities[item.code] ?? DEFAULT_SEVERITY,
      })),
      durationSeconds,
    });
    // The confirmation replaces the whole screen, so a screen-reader user needs an explicit
    // announcement - there's no visible element left to shift focus onto naturally.
    AccessibilityInfo.announceForAccessibility(
      `Check complete. ${template.items.length - failedItems.length} passed, ${failedItems.length} defects.`,
    );
  };

  const progress = total === 0 ? 0 : answeredCount / total;

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: theme.bg }}
      edges={['bottom', 'left', 'right']}
    >
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.sm,
          backgroundColor: theme.surface,
          borderBottomWidth: 1,
          borderBottomColor: theme.borderDecorative,
        }}
      >
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}
        >
          {answeredCount} of {total} checked
        </Text>
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: total, now: answeredCount }}
          accessibilityLabel="Check progress"
          style={{ height: 6, borderRadius: 3, backgroundColor: theme.borderDecorative }}
        >
          <View
            style={{
              width: `${Math.round(progress * 100)}%`,
              height: 6,
              borderRadius: 3,
              backgroundColor: theme.status.ok,
            }}
          />
        </View>
        {markableAsOk.length > 0 ? (
          <Button
            label={`Mark the other ${markableAsOk.length} OK`}
            variant="secondary"
            accessibilityLabel={`Mark the ${markableAsOk.length} unanswered items Pass`}
            onPress={markRestOk}
          />
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        {restoredFrom !== null ? (
          <Text style={{ color: theme.status.info, fontSize: typeScale.body.size }}>
            Restored your check in progress from {formatAsOf(restoredFrom)}.
          </Text>
        ) : null}
        {template.cachedAt !== undefined ? (
          <Text style={{ color: theme.status.warning, fontSize: typeScale.body.size }}>
            Offline. Using the check sheet saved on this phone as of {formatAsOf(template.cachedAt)}
            . The check saves here and sends when you&apos;re back.
          </Text>
        ) : null}
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.navigate('DefectReport', { apparatusId })}
          style={{ alignSelf: 'flex-start', minHeight: targetSize.field, justifyContent: 'center' }}
        >
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
            Report a defect
          </Text>
        </TouchableOpacity>
        {photoError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {photoError}
          </Text>
        ) : null}
        {template.items.map((item) => (
          <ItemRow
            key={item.code}
            item={item}
            theme={theme}
            answer={results[item.code]}
            gated={isGated(item)}
            photoCaptured={photosCaptured[item.code] ?? false}
            severity={severities[item.code] ?? DEFAULT_SEVERITY}
            note={notes[item.code] ?? ''}
            unitId={apparatusId}
            onAnswer={(pass) => answer(item.code, pass)}
            onAddPhoto={() => void handleAddPhoto(item.code)}
            onSeverity={(value) => setSeverities((prev) => ({ ...prev, [item.code]: value }))}
            onNote={(value) => setNotes((prev) => ({ ...prev, [item.code]: value }))}
          />
        ))}
      </ScrollView>
      <View
        style={{
          padding: spacing.lg,
          gap: spacing.sm,
          borderTopWidth: 1,
          borderTopColor: theme.borderDecorative,
          backgroundColor: theme.surface,
        }}
      >
        {submitError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {submitError}
          </Text>
        ) : null}
        <Button
          label={
            unanswered.length > 0
              ? `Submit check — ${unanswered.length} unanswered`
              : 'Submit check'
          }
          size="alert"
          fullWidth
          loading={submitting}
          onPress={() => void handleSubmit()}
        />
      </View>
    </SafeAreaView>
  );
}

interface ItemRowProps {
  item: ChecklistItem;
  theme: SurfaceTheme;
  answer: boolean | undefined;
  gated: boolean;
  photoCaptured: boolean;
  severity: DefectSeverity;
  note: string;
  unitId: string;
  onAnswer: (pass: boolean) => void;
  onAddPhoto: () => void;
  onSeverity: (value: DefectSeverity) => void;
  onNote: (value: string) => void;
}

function ItemRow({
  item,
  theme,
  answer,
  gated,
  photoCaptured,
  severity,
  note,
  unitId,
  onAnswer,
  onAddPhoto,
  onSeverity,
  onNote,
}: ItemRowProps) {
  const choice = (pass: boolean) => {
    const selected = answer === pass;
    const fill = pass ? theme.status.ok : theme.status.danger;
    return (
      <TouchableOpacity
        accessibilityRole="radio"
        accessibilityLabel={pass ? 'Pass' : 'Fail'}
        accessibilityHint={gated ? 'Take the required photo first.' : undefined}
        accessibilityState={{ checked: selected, disabled: gated }}
        disabled={gated}
        onPress={() => onAnswer(pass)}
        style={{
          flex: 1,
          minHeight: targetSize.field,
          flexDirection: 'row',
          gap: spacing.xs,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: radius.default,
          borderWidth: selected ? 0 : 1,
          borderColor: theme.borderStrong,
          opacity: gated ? 0.45 : 1,
          backgroundColor: selected ? fill : 'transparent',
        }}
      >
        {/* Glyph + word, so the selection never rests on colour alone (design.md §2.3). */}
        <Text
          accessible={false}
          style={{ color: selected ? theme.bg : theme.fg, fontSize: typeScale.heading.size }}
        >
          {pass ? '✓' : '✕'}
        </Text>
        <Text
          style={{
            color: selected ? theme.bg : theme.fg,
            fontSize: typeScale.heading.size,
            fontWeight: '700',
          }}
        >
          {pass ? 'Pass' : 'Fail'}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <View
      style={{
        gap: spacing.sm,
        paddingBottom: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.borderDecorative,
      }}
    >
      <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}>
        {item.label}
      </Text>
      {item.requiresPhoto ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={photoCaptured ? 'Photo captured' : 'Add photo'}
          onPress={onAddPhoto}
          style={{ minHeight: targetSize.field, justifyContent: 'center' }}
        >
          <Text
            style={{
              color: photoCaptured ? theme.status.ok : theme.fg,
              fontSize: typeScale.body.size,
              fontWeight: '600',
            }}
          >
            {photoCaptured ? '✓ Photo captured' : 'Add photo (required)'}
          </Text>
        </TouchableOpacity>
      ) : null}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={item.label}
        style={{ flexDirection: 'row', gap: spacing.md }}
      >
        {choice(true)}
        {choice(false)}
      </View>
      {answer === false ? (
        <View style={{ gap: spacing.sm }}>
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            This is reported to the apparatus officer as a defect when you submit.
          </Text>
          <Text style={{ color: theme.fg, fontSize: typeScale.label.size, fontWeight: '600' }}>
            Severity
          </Text>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={`Severity for ${item.label}`}
            style={{ gap: spacing.sm }}
          >
            {SEVERITY_OPTIONS.map((option) => {
              const selected = severity === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  onPress={() => onSeverity(option.value)}
                  style={{
                    minHeight: targetSize.field,
                    justifyContent: 'center',
                    paddingHorizontal: spacing.md,
                    borderRadius: radius.default,
                    borderWidth: selected ? 2 : 1,
                    borderColor: selected ? theme.fg : theme.borderStrong,
                    backgroundColor: selected ? theme.surfaceRaised : 'transparent',
                  }}
                >
                  <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
                    <Text
                      accessible={false}
                      style={{ color: theme.fg, fontSize: typeScale.body.size }}
                    >
                      {selected ? '●' : '○'}
                    </Text>
                    <Text
                      style={{
                        color: theme.fg,
                        fontSize: typeScale.body.size,
                        fontWeight: selected ? '700' : '400',
                      }}
                    >
                      {option.label}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
          {severity === 'OUT_OF_SERVICE' ? (
            <Text
              accessibilityLiveRegion="polite"
              style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
            >
              This takes {unitId} out of service and alerts the apparatus officer.
            </Text>
          ) : null}
          <Text
            nativeID={`note-label-${item.code}`}
            style={{ color: theme.fg, fontSize: typeScale.label.size, fontWeight: '600' }}
          >
            What&apos;s wrong (optional)
          </Text>
          <TextInput
            accessibilityLabel={`What's wrong with ${item.label} (optional)`}
            value={note}
            onChangeText={onNote}
            multiline
            style={{
              minHeight: targetSize.field,
              borderWidth: 1,
              borderColor: theme.borderStrong,
              borderRadius: radius.default,
              padding: spacing.sm,
              color: theme.fg,
              fontSize: typeScale.body.size,
              textAlignVertical: 'top',
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function CompletionView({
  unitId,
  summary,
  outboxId,
  isOnline,
  theme,
  onDone,
}: {
  unitId: string;
  summary: CompletedSummary;
  outboxId: string;
  isOnline: boolean;
  theme: SurfaceTheme;
  onDone: () => void;
}) {
  const delivery = useOutboxItem(outboxId);
  const minutes = Math.floor(summary.durationSeconds / 60);
  const seconds = summary.durationSeconds % 60;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
        >
          Check complete — {unitId}
        </Text>
        <Text style={{ color: theme.fg, fontSize: typeScale.heading.size }}>
          {summary.passed} passed · {summary.defects.length}{' '}
          {summary.defects.length === 1 ? 'defect' : 'defects'}
        </Text>
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
          Took {minutes > 0 ? `${minutes} min ` : ''}
          {seconds} s
        </Text>
        {summary.defects.length > 0 ? (
          <View style={{ gap: spacing.xs }}>
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
              Reported to the apparatus officer:
            </Text>
            {summary.defects.map((defect) => (
              <Text key={defect.label} style={{ color: theme.fg, fontSize: typeScale.body.size }}>
                ✕ {defect.label} — {SEVERITY_LABEL[defect.severity]}
              </Text>
            ))}
          </View>
        ) : null}
        {delivery.state !== 'NOT_QUEUED' ? (
          <DeliveryStatus
            itemId={outboxId}
            label={`Truck check — ${unitId}`}
            state={delivery.state}
            lastError={delivery.lastError}
            isOnline={isOnline}
          />
        ) : null}
        <Button label="Back to apparatus" size="alert" fullWidth onPress={onDone} />
      </ScrollView>
    </SafeAreaView>
  );
}
