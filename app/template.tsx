/** Re-mounts on every navigation, replaying the CSS-only page transition. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
