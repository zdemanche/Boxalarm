import { spacing } from '@boxalarm/design-tokens';
import { View } from 'react-native';
import { navigationRef } from '../../navigation/navigationRef';
import { AlertReadinessBanner } from './AlertReadinessBanner';
import { ALERT_ROUTE_NAME } from './lockScreenPresentation';
import { useAlertReadiness } from './useAlertReadiness';

/**
 * The readiness banner on every tab (review m14 / design review R1), above the tab content. Hidden
 * only while a call's alert screen is focused: there the address and the answer buttons come
 * first (a11y-spec N1 reading order) and the page is already ringing.
 */
export function GlobalReadinessBanner({ focusedRouteName }: { focusedRouteName?: string }) {
  const readiness = useAlertReadiness();
  if (focusedRouteName === ALERT_ROUTE_NAME || readiness.blocking.length === 0) return null;
  return (
    <View style={{ paddingHorizontal: spacing.md, paddingTop: spacing.sm }}>
      <AlertReadinessBanner
        blocking={readiness.blocking}
        onSeeAll={() => {
          if (navigationRef.isReady())
            navigationRef.navigate('Me', { screen: 'SelfTest' } as never);
        }}
      />
    </View>
  );
}
