import type { World } from '@iwsdk/core';

/**
 * XR 手部输入仲裁兜底（pending upstream @iwsdk/xr-input 1.0.1）。
 *
 * 部分头显 runtime（Swan 浏览器实测）在手部捏合时会注入不带 gamepad 的虚拟控制器
 * source；IWSDK 的 assignInputSource 采用"后写者赢"，虚拟控制器抢走 primary 后，
 * 该侧射线与点击链路（connected 要求 gamepad || hand）永久失效。
 *
 * 规则：无 gamepad 且同侧已有手部 source 的控制器跳过注册；其余照常注册（含 Meta
 * 真实控制器的 gamepad 迟到窗口）。上游修复后删除本文件及 index.ts 中的调用。
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
