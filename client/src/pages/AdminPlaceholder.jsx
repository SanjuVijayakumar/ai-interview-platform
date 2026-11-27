export default function AdminPlaceholder({ title, children }) {
  return (
    <section className="theme-card-surface rounded-2xl border p-5 sm:p-6">
      {title && <h2 className="mb-2 text-xl font-semibold theme-text-primary">{title}</h2>}
      <p className="text-sm theme-text-secondary">{children ?? "This feature is pending."}</p>
    </section>
  );
}
