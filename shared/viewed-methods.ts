import type { IndexedMethod } from './model.js';

export interface ViewedMethod {
  id: string;
  scope: string;
  path: string;
  hash: string;
  viewedAt: string;
}
export interface MethodView {
  method: IndexedMethod;
  key: string;
  viewed: boolean;
}
