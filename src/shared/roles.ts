/**
 * Roles and what each one may do.
 *
 * Kept as shared functions rather than scattered string comparisons so the
 * server's enforcement and the UI's affordances cannot drift apart. The
 * server is the only thing that actually enforces them -- the UI uses these
 * to avoid offering buttons that would 403.
 */

export type UserRole = "admin" | "manager" | "viewer";

export const USER_ROLES: UserRole[] = ["admin", "manager", "viewer"];

export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin:
    "Everything a manager can do, plus changing the local radio's settings, managing user accounts and clearing the node database.",
  manager:
    "Read everything, and use the radio — probe nodes for admin access and change their configuration.",
  viewer:
    "Read-only. Can see the fleet and re-read the local radio over USB, but never transmits.",
};

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as string[]).includes(value);
}

/**
 * May send something over the mesh: probing a node, writing its config,
 * cancelling an in-flight operation. Anything that puts the radio to work
 * on someone's behalf.
 */
export function canOperateRadio(role: UserRole): boolean {
  return role === "admin" || role === "manager";
}

/**
 * May manage accounts, destroy collected data, and change the local radio's
 * settings -- the last because a preset, slot or channel change moves the
 * whole console onto a different mesh.
 */
export function canAdminister(role: UserRole): boolean {
  return role === "admin";
}

/**
 * May ask the assistant a question. Read-only in effect, but every question
 * is a paid call to the LLM provider on the server owner's key, so it sits
 * with the roles trusted to put the radio to work rather than with viewers.
 */
export function canAskAssistant(role: UserRole): boolean {
  return role === "admin" || role === "manager";
}

/**
 * The account defined in config.yaml rather than the database.
 *
 * It exists so the console can always be reached: the database can be
 * empty, corrupted or restored from a backup with no usable accounts in
 * it, and this one still works because it comes from the mounted config.
 * That also means it cannot be deleted or demoted from inside the app, and
 * the name is reserved so a database user can never shadow it.
 */
export const BUILT_IN_ADMIN_USERNAME = "admin";
