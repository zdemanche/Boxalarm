import { radiusScale, spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useState } from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import Config from 'react-native-config';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { cardShadow } from '../../components/ui/theme';
import { setServiceStatus } from '../../features/checks/serviceStatusApi';
import type { ApparatusStatus } from '../../features/checks/types';
import { ApiError, ApiTimeoutError } from '../../lib/apiClient';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { ROW_TEXT_SIZE } from './fieldText';
import { RadioOption } from './RadioOption';

/** Reasons offered for taking a unit out of service: pick-from-list, no typing (design.md §4.8). */
export const OOS_REASONS = [
  'Failed truck check',
  'Mechanical problem',
  'Scheduled maintenance',
  'Damage',
  'Other — ask the apparatus officer',
] as const;

type Phase =
  | { kind: 'choose' }
  | { kind: 'confirm' }
  | { kind: 'saving' }
  | { kind: 'done'; status: ApparatusStatus }
  | { kind: 'failed'; message: string };

function failureMessage(error: unknown, unitId: string): string {
  if (error instanceof ApiError) {
    if (error.problem.status === 403) {
      return `Your role can't change ${unitId}'s service status. Nothing was changed.`;
    }
    if (error.problem.status === 409) {
      return `${unitId} was already changed by someone else. Go back to see its current status.`;
    }
    return `Boxalarm refused the change (${error.problem.title}). ${unitId}'s service status was not changed.`;
  }
  if (error instanceof ApiTimeoutError) {
    return `No answer from Boxalarm. ${unitId}'s status may or may not have changed — go back and check before trying again.`;
  }
  return `Couldn't reach Boxalarm. ${unitId}'s service status was not changed.`;
}

/**
 * Take a unit out of service, or return it (F4.4), from the apparatus screen. Cedar
 * UpdateServiceStatus (apparatus officer, officer, chief, admin); the picker only links here for
 * those roles. Online only and confirmed first: a status the department acts on is never queued
 * to land later, so offline it is refused plainly.
 */
export function ServiceStatusScreen() {
  const theme = useTheme();
  const navigation = useNavigation();
  const { unitId, status } = useRoute().params as ChecksStackParamList['ServiceStatus'];
  const auth = useOptionalAuth();
  const { isOnline } = useOptionalConnectivity();
  const apiBaseUrl = Config.API_BASE_URL ?? '';
  const target: ApparatusStatus = status === 'IN_SERVICE' ? 'OUT_OF_SERVICE' : 'IN_SERVICE';
  const takingOut = target === 'OUT_OF_SERVICE';
  const [reason, setReason] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });

  const action = takingOut ? `Take ${unitId} out of service` : `Return ${unitId} to service`;
  const consequence = takingOut
    ? `Every member will see ${unitId} out of service${reason ? ` (${reason})` : ''} until someone returns it to service.`
    : `Every member will see ${unitId} in service again.`;

  const submit = async () => {
    if (!auth || !isOnline) return;
    setPhase({ kind: 'saving' });
    try {
      await setServiceStatus(
        auth,
        apiBaseUrl,
        unitId,
        target,
        takingOut ? (reason ?? '') : undefined,
      );
      setPhase({ kind: 'done', status: target });
      AccessibilityInfo.announceForAccessibility(
        takingOut ? `${unitId} is now out of service.` : `${unitId} is back in service.`,
      );
    } catch (error) {
      const message = failureMessage(error, unitId);
      setPhase({ kind: 'failed', message });
      AccessibilityInfo.announceForAccessibility(message);
    }
  };

  const body = (text: string, color = theme.fg) => (
    <Text style={{ color, fontSize: typeScale.body.size }}>{text}</Text>
  );
  const shown = phase.kind === 'done' ? phase.status : status;

  return (
    <Screen>
      <Card>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.sm,
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
          >
            {unitId}
          </Text>
          <StatusChip
            status={shown === 'IN_SERVICE' ? 'ok' : 'danger'}
            label={shown === 'IN_SERVICE' ? 'In service' : 'Out of service'}
          />
        </View>
        {phase.kind === 'done' ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: theme.fg, fontSize: ROW_TEXT_SIZE, fontWeight: '600' }}
          >
            {takingOut ? `${unitId} is now out of service.` : `${unitId} is back in service.`}
          </Text>
        ) : null}
      </Card>

      {phase.kind === 'done' ? (
        <Button
          label="Back to apparatus"
          size="alert"
          fullWidth
          onPress={() => navigation.goBack()}
        />
      ) : !isOnline ? (
        <>
          <Card>
            <Text
              accessibilityRole="alert"
              style={{
                color: theme.status.warning,
                fontSize: typeScale.body.size,
                fontWeight: '600',
              }}
            >
              You&apos;re offline. Service status can only be changed with a connection, so nothing
              was changed. Try again when you have signal, or radio the officer.
            </Text>
          </Card>
          <Button
            label="Back to apparatus"
            variant="secondary"
            onPress={() => navigation.goBack()}
          />
        </>
      ) : (
        <>
          {takingOut ? (
            <Card>
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={`Why is ${unitId} out of service?`}
                style={{ gap: spacing.sm }}
              >
                <Text style={{ color: theme.fg, fontSize: ROW_TEXT_SIZE, fontWeight: '600' }}>
                  Why is {unitId} out of service?
                </Text>
                {OOS_REASONS.map((option) => (
                  <RadioOption
                    key={option}
                    label={option}
                    selected={reason === option}
                    disabled={phase.kind === 'saving'}
                    onPress={() => {
                      setReason(option);
                      if (phase.kind !== 'choose') setPhase({ kind: 'choose' });
                    }}
                  />
                ))}
                {!reason ? body('Choose a reason first.', theme.fgMuted) : null}
              </View>
            </Card>
          ) : null}

          {phase.kind === 'failed' ? (
            <Card>
              <Text
                accessibilityRole="alert"
                style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
              >
                {phase.message}
              </Text>
            </Card>
          ) : null}

          {phase.kind === 'confirm' || phase.kind === 'saving' ? (
            // The confirmation keeps its 2px status edge: it is the step that changes what every
            // member sees.
            <View
              style={{
                gap: spacing.sm,
                padding: spacing.md,
                borderRadius: radiusScale.lg,
                borderWidth: 2,
                borderColor: takingOut ? theme.status.danger : theme.status.ok,
                backgroundColor: theme.card,
                ...cardShadow(theme),
              }}
            >
              <Text
                accessibilityRole="header"
                style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}
              >
                {action}?
              </Text>
              {body(consequence)}
              <Button
                label={takingOut ? 'Yes, take it out of service' : 'Yes, return it to service'}
                variant={takingOut ? 'danger' : 'primary'}
                size="alert"
                fullWidth
                loading={phase.kind === 'saving'}
                onPress={() => void submit()}
              />
              <Button
                label="Cancel"
                variant="secondary"
                disabled={phase.kind === 'saving'}
                onPress={() => setPhase({ kind: 'choose' })}
              />
            </View>
          ) : (
            <Button
              label={action}
              variant={takingOut ? 'danger' : 'primary'}
              size="alert"
              fullWidth
              disabled={takingOut && !reason}
              onPress={() => setPhase({ kind: 'confirm' })}
            />
          )}
        </>
      )}
    </Screen>
  );
}
