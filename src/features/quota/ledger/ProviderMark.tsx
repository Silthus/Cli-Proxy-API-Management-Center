import { useTranslation } from 'react-i18next';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import styles from './QuotaLedger.module.scss';

export interface ProviderMarkProps {
  provider: string;
  resolvedTheme: ResolvedTheme;
  withLabel?: boolean;
}

/** Provider icon, optionally followed by its name. */
export function ProviderMark({ provider, resolvedTheme, withLabel = true }: ProviderMarkProps) {
  const { t } = useTranslation();
  const label = getTypeLabel(t, provider);
  const iconSrc = getAuthFileIcon(provider, resolvedTheme);
  return (
    <span className={styles.providerMark}>
      <span
        className={styles.providerIcon}
        style={
          isThemeSurfaceIconProvider(provider)
            ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
            : undefined
        }
      >
        {iconSrc ? <img src={iconSrc} alt="" /> : <span>{label.slice(0, 1).toUpperCase()}</span>}
      </span>
      {withLabel && <span className={styles.providerName}>{label}</span>}
    </span>
  );
}
