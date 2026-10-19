export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className="brand" href="/" aria-label="Tollbooth home">
      <img src="/tollbooth-mark.svg" alt="" width="32" height="32" />
      {!compact && <span>Tollbooth</span>}
    </a>
  );
}
