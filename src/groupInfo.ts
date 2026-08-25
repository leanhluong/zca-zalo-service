// groupInfo.ts — Helper lấy thông tin nhóm Zalo qua zca-js@2.1.2
//
// Shape THẬT của zca-js@2.1.2 (đã verify từ dist/apis/getGroupInfo.js):
//   api.getGroupInfo(groupId | groupId[]) → {
//     removedsGroup: string[],
//     unchangedsGroup: string[],
//     gridInfoMap: { [groupId]: GroupInfo }   // ← Ở TOP LEVEL, KHÔNG phải .data.gridInfoMap
//   }
//   GroupInfo = { groupId, name, desc, avt, fullAvt, totalMember, memberIds, ... }
//
//   api.getAllGroups() → {
//     version: string,
//     gridVerMap: { [groupId]: version }      // ← CHỈ có groupId (keys), KHÔNG có tên/avatar
//   }
// → Muốn tên/avatar phải feed các groupId này vào getGroupInfo.

import type { GroupFields, GroupMember, GroupSummary, ZaloApi, ZaloRaw } from './types.js';
import { errMsg } from './errors.js';

// Cache in-memory theo groupId để không gọi getGroupInfo lặp mỗi tin (giảm rate-limit).
const groupInfoCache = new Map<string, GroupFields & { ts: number }>();
const GROUP_INFO_TTL_MS = 10 * 60 * 1000; // 10 phút

// Trích đúng field từ một entry GroupInfo (shape zca-js@2.1.2)
function extractGroupFields(g: ZaloRaw): GroupFields | null {
  if (!g) return null;
  return {
    name: g.name ?? g.groupName ?? g.fullName ?? null,
    avatar: g.avt ?? g.fullAvt ?? g.avatar ?? null,
    memberCount: g.totalMember ?? (Array.isArray(g.memberIds) ? g.memberIds.length : null),
  };
}

// Đọc gridInfoMap từ response getGroupInfo — hỗ trợ cả shape mới (top-level)
// lẫn shape cũ (.data.gridInfoMap) để an toàn trước/sau nâng lib.
function resolveGridInfoMap(resp: ZaloRaw): Record<string, ZaloRaw> | null {
  return resp?.gridInfoMap ?? resp?.data?.gridInfoMap ?? null;
}

/** Lấy tên/avatar/số thành viên của 1 nhóm — cache theo groupId. */
export async function getGroupInfoCached(
  api: ZaloApi | null | undefined,
  groupId: string | number,
): Promise<GroupFields | null> {
  const key = String(groupId);
  if (!api || !key) return null;

  const cached = groupInfoCache.get(key);
  if (cached && Date.now() - cached.ts < GROUP_INFO_TTL_MS) {
    return { name: cached.name, avatar: cached.avatar, memberCount: cached.memberCount };
  }

  try {
    const resp = await api.getGroupInfo([key]);
    const gridInfoMap = resolveGridInfoMap(resp);
    // gridInfoMap keyed theo groupId; fallback lấy phần tử đầu nếu key lệch
    const entry = gridInfoMap?.[key] ?? (gridInfoMap ? Object.values(gridInfoMap)[0] : null);
    const fields = extractGroupFields(entry);
    if (fields && (fields.name || fields.avatar)) {
      groupInfoCache.set(key, { ...fields, ts: Date.now() });
    }
    return fields;
  } catch (err) {
    console.warn(`[groupInfo] getGroupInfo error for groupId=${key}:`, errMsg(err));
    return null;
  }
}

/**
 * Liệt kê tất cả nhóm của account: getAllGroups() → danh sách groupId,
 * rồi enrich qua getGroupInfo (batch) để có tên/avatar/số thành viên.
 */
export async function listAllGroups(api: ZaloApi | null | undefined): Promise<GroupSummary[]> {
  if (!api) return [];

  const allResp: ZaloRaw = await api.getAllGroups();
  const gridVerMap = allResp?.gridVerMap ?? allResp?.data?.gridVerMap ?? {};
  const groupIds = Object.keys(gridVerMap);
  if (groupIds.length === 0) return [];

  // Enrich theo LÔ — Zalo từ chối getGroupInfo với mảng quá lớn (vd 900+ nhóm 1 lần → null).
  // Chunk 50 id/lần + gộp gridInfoMap; delay nhỏ giữa lô để tránh rate-limit.
  const CHUNK = 50;
  const gridInfoMap: Record<string, ZaloRaw> = {};
  for (let i = 0; i < groupIds.length; i += CHUNK) {
    const batch = groupIds.slice(i, i + CHUNK);
    try {
      const infoResp = await api.getGroupInfo(batch);
      const map = resolveGridInfoMap(infoResp);
      if (map) Object.assign(gridInfoMap, map);
    } catch (err) {
      console.warn(`[groupInfo] listAllGroups getGroupInfo chunk ${i} error:`, errMsg(err));
    }
    if (i + CHUNK < groupIds.length) await new Promise((r) => setTimeout(r, 300));
  }

  return groupIds.map((groupId) => {
    const entry = gridInfoMap?.[groupId] ?? null;
    const fields = extractGroupFields(entry);
    // Cache lại luôn để tin nhóm về sau không phải gọi lại
    if (fields && (fields.name || fields.avatar)) {
      groupInfoCache.set(groupId, { ...fields, ts: Date.now() });
    }
    return {
      groupId,
      name: fields?.name ?? null,
      avatar: fields?.avatar ?? null,
      memberCount: fields?.memberCount ?? null,
    };
  });
}

// Trích profile thành viên từ response getGroupMembersInfo (shape zca-js@2.1.2).
//   getGroupMembersInfo(memberIds) → {
//     profiles: { [memberId]: { displayName, zaloName, avatar, id, globalId, ... } },
//     unchangeds_profile: []
//   }
function resolveMemberProfiles(resp: ZaloRaw): Record<string, ZaloRaw> | null {
  return resp?.profiles ?? resp?.data?.profiles ?? null;
}

// memVerList entry có dạng "uid_version" (vd "12345_3") → tách lấy uid.
function stripMemVer(v: unknown): string {
  const s = String(v);
  const i = s.indexOf('_');
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * Liệt kê thành viên của 1 nhóm với tên + avatar.
 *
 * Shape zca-js@2.1.2 (getGroupInfo → gridInfoMap[groupId]) có 3 NGUỒN thành viên:
 *   - currentMems: [{ id, dName, zaloName, avatar, avatar_25, ... }]  ← CÓ avatar SẴN
 *   - memberIds:   [uid]                                              ← thường RỖNG ở v2.1.2
 *   - memVerList:  ["uid_version"]                                    ← uid + version
 *
 * Ưu tiên `currentMems` vì đã kèm avatar → dựng collage nhóm KHÔNG cần gọi thêm.
 * Chỉ khi currentMems rỗng mới rơi xuống memberIds/memVerList + getGroupMembersInfo.
 * (Bản cũ chỉ đọc memberIds → v2.1.2 trả rỗng → members = [] → không có avatar để ghép.)
 */
export async function listGroupMembers(
  api: ZaloApi | null | undefined,
  groupId: string | number,
): Promise<GroupMember[]> {
  const key = String(groupId);
  if (!api || !key) return [];

  const infoResp: ZaloRaw = await api.getGroupInfo([key]);
  const gridInfoMap = resolveGridInfoMap(infoResp);
  const entry = gridInfoMap?.[key] ?? (gridInfoMap ? Object.values(gridInfoMap)[0] : null);
  if (!entry) return [];

  const currentMems = Array.isArray(entry.currentMems) ? entry.currentMems : [];
  const memberIds = Array.isArray(entry.memberIds) ? entry.memberIds.map(String) : [];
  const memVerIds = Array.isArray(entry.memVerList) ? entry.memVerList.map(stripMemVer) : [];

  console.log(
    `[groupInfo] listGroupMembers groupId=${key} currentMems=${currentMems.length} ` +
      `memberIds=${memberIds.length} memVerList=${memVerIds.length} total=${entry.totalMember ?? '?'}`,
  );

  // 1) currentMems đã kèm avatar → dùng trực tiếp, không cần getGroupMembersInfo.
  if (currentMems.length > 0) {
    return currentMems.map((m: ZaloRaw) => ({
      uid: String(m.id),
      name: m.zaloName ?? m.dName ?? null,
      avatar: m.avatar ?? m.avatar_25 ?? null,
    }));
  }

  // 2) Fallback: chỉ có uid (memberIds hoặc memVerList) → enrich qua getGroupMembersInfo.
  const uids = memberIds.length > 0 ? memberIds : memVerIds;
  if (uids.length === 0) return [];

  let profiles: Record<string, ZaloRaw> | null = null;
  try {
    const membersResp = await api.getGroupMembersInfo(uids);
    profiles = resolveMemberProfiles(membersResp);
  } catch (err) {
    console.warn(`[groupInfo] getGroupMembersInfo error for groupId=${key}:`, errMsg(err));
  }

  return uids.map((uid: string) => {
    // profiles có thể keyed theo uid hoặc uid_0 (theo pversion) → thử cả hai
    const p = profiles?.[uid] ?? profiles?.[`${uid}_0`] ?? null;
    return {
      uid,
      name: p?.zaloName ?? p?.displayName ?? null,
      avatar: p?.avatar ?? null,
    };
  });
}
