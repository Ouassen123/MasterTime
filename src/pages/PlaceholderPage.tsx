/**
 * PlaceholderPage — cible des entrées de navigation non implémentées (P6b+).
 */
import { Card, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

const { Title, Text } = Typography;

export function PlaceholderPage(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Card>
      <Title level={4}>{t('placeholder.title')}</Title>
      <Text type="secondary">{t('placeholder.body')}</Text>
    </Card>
  );
}
