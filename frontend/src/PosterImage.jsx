import { useEffect, useState } from 'react';
import { gradientFor } from './utils';

export function getPosterSrc(url) {
  if (typeof url !== 'string') return null;
  const value = url.trim();
  if (!value) return null;
  if (value.startsWith('/api/')) return value;
  if (value.startsWith('//')) return `/api/poster?url=${encodeURIComponent(`https:${value}`)}`;
  if (/^https?:\/\//i.test(value)) return `/api/poster?url=${encodeURIComponent(value)}`;
  return null;
}

export default function PosterImage({
  url,
  title,
  icon = 'movie',
  className = '',
  style = {},
  imgClassName = '',
  imgStyle = {},
  fallback = null,
  fallbackClassName = '',
  fallbackStyle = {},
  loading = 'lazy',
  decoding = 'async',
  alt,
}) {
  const [failed, setFailed] = useState(false);
  const src = getPosterSrc(url);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const showFallback = !src || failed;

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        overflow: 'hidden',
        background: gradientFor(title || ''),
        ...style,
      }}
    >
      {!showFallback && (
        <img
          src={src}
          alt={alt ?? (title ? `${title} poster` : 'Media poster')}
          loading={loading}
          decoding={decoding}
          className={imgClassName}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            ...imgStyle,
          }}
          onError={() => setFailed(true)}
        />
      )}
      {showFallback && (
        fallback || (
          <div
            className={fallbackClassName}
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...fallbackStyle,
            }}
          >
            <span
              className="material-symbols-rounded"
              style={{
                fontSize: 24,
                fontVariationSettings: "'FILL' 1",
                color: 'rgba(255,255,255,0.32)',
              }}
            >
              {icon}
            </span>
          </div>
        )
      )}
    </div>
  );
}
