import { z } from "zod";

/**
 * DBLab (DLE 4.x) response shapes. Only the fields the bash tooling proved
 * (`.status.code`, `.status.message`, `.db.host`, `.db.port`, branch `.name`)
 * are trusted; everything else is optional + passthrough so field drift in the
 * engine never crashes the CLI.
 */

export const cloneSchema = z
  .object({
    id: z.string(),
    status: z.object({ code: z.string(), message: z.string().optional() }).passthrough(),
    db: z
      .object({
        host: z.string().optional(),
        port: z.union([z.string(), z.number()]).optional(),
        username: z.string().optional(),
        dbName: z.string().optional(),
      })
      .passthrough()
      .optional(),
    branch: z.string().optional(),
    snapshot: z.unknown().optional(),
    createdAt: z.string().optional(),
    protected: z.boolean().optional(),
  })
  .passthrough();
export type Clone = z.infer<typeof cloneSchema>;

export const branchSchema = z
  .object({
    name: z.string(),
    parent: z.string().optional(),
    dataStateAt: z.string().optional(),
    snapshotID: z.string().optional(),
    numSnapshots: z.number().optional(),
  })
  .passthrough();
export type Branch = z.infer<typeof branchSchema>;

export const snapshotSchema = z
  .object({
    id: z.string(),
    createdAt: z.string().optional(),
    dataStateAt: z.string().optional(),
    physicalSize: z.number().optional(),
    logicalSize: z.number().optional(),
    pool: z.string().optional(),
    branch: z.unknown().optional(),
  })
  .passthrough();
export type Snapshot = z.infer<typeof snapshotSchema>;

export const statusSchema = z
  .object({
    status: z.object({ code: z.string().optional(), message: z.string().optional() }).passthrough().optional(),
    engine: z
      .object({ version: z.string().optional(), startedAt: z.string().optional(), telemetry: z.unknown().optional() })
      .passthrough()
      .optional(),
    cloning: z
      .object({
        clones: z.array(cloneSchema).optional(),
        expectedCloningTime: z.number().optional(),
        numClones: z.number().optional(),
      })
      .passthrough()
      .optional(),
    retrieving: z
      .object({
        mode: z.string().optional(),
        status: z.string().optional(),
        lastRefresh: z.string().nullable().optional(),
        nextRefresh: z.string().nullable().optional(),
        alerts: z.unknown().optional(),
        activity: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    pools: z
      .array(
        z
          .object({
            name: z.string().optional(),
            mode: z.string().optional(),
            dataStateAt: z.string().optional(),
            status: z.string().optional(),
            cloneList: z.array(z.string()).optional(),
            fileSystem: z
              .object({ size: z.number().optional(), free: z.number().optional(), used: z.number().optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type InstanceStatus = z.infer<typeof statusSchema>;
