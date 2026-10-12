import { typeScale } from '@boxalarm/design-tokens';
import { Text } from 'react-native';
import { Card, Screen, useTheme } from '../components/ui';

export function PlaceholderScreen({ label }: { label: string }) {
  const theme = useTheme();

  return (
    <Screen scroll={false}>
      <Card>
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>{label}</Text>
      </Card>
    </Screen>
  );
}
