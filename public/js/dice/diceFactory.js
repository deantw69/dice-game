// 依設定回傳採用的骰子渲染器,正式房間透過此處切換 css3d / three
import { createRenderer as createCss3d } from './diceCss3d.js';
import { createRenderer as createThree } from './diceThree.js';

export function createDice(type, container, options) {
  if (type === 'three') return createThree(container, options);
  return createCss3d(container, options);
}
