/**
 * The sections of a node's full configuration, as the raw JSON view asks for
 * them. Imported by both halves: the server validates a request against this
 * list and the UI builds its picker and its round-trip estimate from it.
 *
 * Each `id` of the config and module groups is also the name of the matching
 * protobuf variant, which is how the server checks a reply answers the
 * question asked.
 *
 * Only what `@meshtastic/core`'s bundled protobufs can ask for and carry
 * (CLAUDE.md section 4). Newer modules such as `tak` are absent because the
 * request cannot be named and the reply could not be told apart.
 */

export type RawConfigGroup = "config" | "module" | "identity";

export const RAW_CONFIG_SECTIONS = [
  { id: "device", label: "Device", group: "config", reads: 1 },
  { id: "position", label: "Position", group: "config", reads: 1 },
  { id: "power", label: "Power", group: "config", reads: 1 },
  { id: "network", label: "Network", group: "config", reads: 1 },
  { id: "display", label: "Display", group: "config", reads: 1 },
  { id: "lora", label: "LoRa", group: "config", reads: 1 },
  { id: "bluetooth", label: "Bluetooth", group: "config", reads: 1 },
  { id: "security", label: "Security", group: "config", reads: 1 },

  { id: "mqtt", label: "MQTT", group: "module", reads: 1 },
  { id: "serial", label: "Serial", group: "module", reads: 1 },
  { id: "externalNotification", label: "External notification", group: "module", reads: 1 },
  { id: "storeForward", label: "Store and forward", group: "module", reads: 1 },
  { id: "rangeTest", label: "Range test", group: "module", reads: 1 },
  { id: "telemetry", label: "Telemetry", group: "module", reads: 1 },
  { id: "cannedMessage", label: "Canned messages", group: "module", reads: 1 },
  { id: "audio", label: "Audio", group: "module", reads: 1 },
  { id: "remoteHardware", label: "Remote hardware", group: "module", reads: 1 },
  { id: "neighborInfo", label: "Neighbor info", group: "module", reads: 1 },
  { id: "ambientLighting", label: "Ambient lighting", group: "module", reads: 1 },
  { id: "detectionSensor", label: "Detection sensor", group: "module", reads: 1 },
  { id: "paxcounter", label: "Paxcounter", group: "module", reads: 1 },

  { id: "owner", label: "Owner", group: "identity", reads: 1 },
  { id: "metadata", label: "Metadata", group: "identity", reads: 1 },
  // One read per slot, disabled slots included.
  { id: "channels", label: "Channels", group: "identity", reads: 8 },
] as const satisfies readonly {
  id: string;
  label: string;
  group: RawConfigGroup;
  reads: number;
}[];

export type RawConfigSectionId = (typeof RAW_CONFIG_SECTIONS)[number]["id"];

export const RAW_CONFIG_GROUP_LABELS: Record<RawConfigGroup, string> = {
  config: "Radio config",
  module: "Modules",
  identity: "Identity and channels",
};

/** One section as last read from the node. Secrets are already gone. */
export interface RawConfigSection {
  section: RawConfigSectionId;
  /** UTC epoch seconds. Per section, because a query may ask for only some. */
  fetchedAt: number;
  data: unknown;
}

/** What one query established, for saying what did not arrive. */
export interface RawConfigReadResult {
  /** Answered, and now stored. */
  read: RawConfigSectionId[];
  /** Asked and not answered, with why. A section may be partly read too. */
  failed: { section: RawConfigSectionId; error: string }[];
  /** Never asked, because the node stopped answering or refused. */
  skipped: RawConfigSectionId[];
  /** Everything stored for the node after this query, in list order. */
  sections: RawConfigSection[];
}

export function isRawConfigSectionId(value: unknown): value is RawConfigSectionId {
  return RAW_CONFIG_SECTIONS.some((section) => section.id === value);
}

/** Admin requests a set of sections takes: its cost in mesh round trips. */
export function rawConfigReads(sections: readonly RawConfigSectionId[]): number {
  return RAW_CONFIG_SECTIONS.filter((section) =>
    (sections as readonly string[]).includes(section.id),
  ).reduce((total, section) => total + section.reads, 0);
}
