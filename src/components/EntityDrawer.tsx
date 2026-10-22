/**
 * EntityDrawer — drawer droit 480px (DESIGN) hébergeant le formulaire d'un
 * référentiel (création = même drawer vide). Mappe les erreurs serveur
 * `{ field, message }` sur les champs du Form antd ; erreur globale en Alert.
 * Fermer un drawer modifié demande confirmation (« Abandonner les
 * modifications ? », EXPERIENCE — primitives d'interaction).
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, Form, Modal, Space } from 'antd';
import { useTranslation } from 'react-i18next';
import type { ApiResult } from '../../shared/types';

export interface EntityDrawerProps<TValues extends object> {
  open: boolean;
  title: string;
  /** Valeurs initiales (édition) — undefined = création. */
  initialValues?: Partial<TValues>;
  /** Appel API : le parent rafraîchit ses données et retourne le ApiResult. */
  onSubmit: (values: TValues) => Promise<ApiResult<unknown>>;
  onClose: () => void;
  children: React.ReactNode;
}

export function EntityDrawer<TValues extends object>(
  props: EntityDrawerProps<TValues>,
): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<TValues>();
  const [submitting, setSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const dirty = useRef(false);

  // À l'ouverture : réinitialise le formulaire puis injecte les valeurs initiales.
  useEffect(() => {
    if (props.open) {
      setGlobalError(null);
      dirty.current = false;
      form.resetFields();
      if (props.initialValues) {
        form.setFieldsValue(props.initialValues as TValues);
      }
    }
  }, [props.open, props.initialValues, form]);

  const requestClose = (): void => {
    if (dirty.current && !submitting) {
      Modal.confirm({
        title: t('form.discardTitle'),
        content: t('form.discardBody'),
        okText: t('common.yes'),
        cancelText: t('common.no'),
        onOk: () => props.onClose(),
      });
      return;
    }
    props.onClose();
  };

  const handleFinish = async (values: TValues): Promise<void> => {
    setSubmitting(true);
    setGlobalError(null);
    try {
      const res = await props.onSubmit(values);
      if (res.ok) {
        dirty.current = false;
        props.onClose();
        return;
      }
      if (res.fields && res.fields.length > 0) {
        // Le serveur nomme les champs par chaîne — mappés tels quels sur le Form.
        form.setFields(
          res.fields.map((f) => ({ name: f.field, errors: [f.message] })) as never,
        );
      } else {
        setGlobalError(res.error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={props.open}
      title={props.title}
      width={480}
      onClose={requestClose}
      maskClosable={false}
      footer={
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={requestClose}>{t('common.cancel')}</Button>
          <Button type="primary" loading={submitting} onClick={() => form.submit()}>
            {t('common.save')}
          </Button>
        </Space>
      }
    >
      {globalError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('form.serverError')}
          description={globalError}
        />
      )}
      <Form<TValues>
        form={form}
        layout="vertical"
        onFinish={(values) => void handleFinish(values)}
        onValuesChange={() => {
          dirty.current = true;
        }}
        requiredMark="optional"
      >
        {props.children}
      </Form>
    </Drawer>
  );
}
