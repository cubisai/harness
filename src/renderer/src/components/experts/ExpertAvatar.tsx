// The bundled portraits (see assets/experts/LICENSE.md): `<expert-id>.svg`, and `<team-id>--<member-id>.svg` for a team member.
const FILES = import.meta.glob("../../assets/experts/*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const URLS = new Map(Object.entries(FILES).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".svg".length), url]));

/** The portrait's URL for an expert id (or `team--member` key), when one is bundled. */
export function expertAvatarUrl(id: string): string | undefined {
  return URLS.get(id);
}

/** A member's initials: the first letters of the first two words, uppercase. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0] ?? "")
    .join("")
    .toUpperCase();
}

/** The avatar key for a team member: portraits are per team, so two teams' "reviewer" differ. */
export const memberAvatarId = (teamId: string, memberId: string): string => `${teamId}--${memberId}`;

/**
 * An expert's (or team member's) avatar: its bundled portrait, else its initials. `className` carries the size and
 * shape of the place it sits in, so the portrait and the initials fill the same box.
 */
export function ExpertAvatar({ id, text, className }: { id: string; text: string; className: string }) {
  const url = expertAvatarUrl(id);
  if (url) return <img className={`${className} expert-avatar-img`} src={url} alt="" aria-hidden draggable={false} />;
  return (
    <span className={className} aria-hidden>
      {text}
    </span>
  );
}
