import type { World } from '@iwsdk/core';

/**
 * XR 手部输入仲裁兜底（pending upstream @iwsdk/xr-input 1.0.1）
 *
 * 部分头显 runtime（Swan 浏览器实测，2026-10-22 起）在手部捏合时会向
 * session.inputSources 注入一个不带 gamepad 的虚拟控制器 source。IWSDK 的
 * assignInputSource 对同侧手/控制器共存采用"后写者赢"仲裁，虚拟控制器会抢走
 * primary；而 connected 判定要求 gamepad || hand，于是该侧射线与点击链路永久
 * 失效——表现为捏合时射线变蓝后不再恢复，手里多出一个控制器模型。
 *
 * 仲裁规则（能力优先）：
 * - 控制器带 gamepad：照常注册（Meta 真实控制器行为不变）
 * - 控制器无 gamepad 且同侧无手部 source：照常注册（Meta 的 gamepad 迟到窗口安全）
 * - 控制器无 gamepad 且同侧存在手部 source：跳过注册（Swan 注入的虚拟控制器，
 *   不再抢 primary， phantom 控制器模型也随之消失）
 *
 * 上游修复该仲裁后，删除本文件及 index.ts 中的调用即可。
 */

type XrManagerInternals = {
  updateActiveInputSources(session: XRSession): void;
  assignInputSource(inputSource: XRInputSource, isPrimary: boolean): void;
};

export function installHandPriorityArbitration(world: World): void {
  const manager = world.input.xr as unknown as XrManagerInternals;
  const originalUpdate = manager.updateActiveInputSources;
  const originalAssign = manager.assignInputSource;
  const handsThisFrame = new Set<string>();

  manager.updateActiveInputSources = function (this: XrManagerInternals, session: XRSession) {
    handsThisFrame.clear();
    for (const inputSource of session.inputSources) {
      if (inputSource.hand) handsThisFrame.add(inputSource.handedness);
    }
    originalUpdate.call(this, session);
  };

  manager.assignInputSource = function (
    this: XrManagerInternals,
    inputSource: XRInputSource,
    isPrimary: boolean,
  ) {
    if (!inputSource.hand && !inputSource.gamepad && handsThisFrame.has(inputSource.handedness)) {
      return;
    }
    originalAssign.call(this, inputSource, isPrimary);
  };
}
