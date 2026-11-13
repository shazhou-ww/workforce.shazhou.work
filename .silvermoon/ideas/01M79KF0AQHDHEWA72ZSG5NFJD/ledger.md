# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 拆分近月就绪与年度补采状态
- [x] **I-S02:** 实现可恢复的分批补采与历史复用
- [x] **I-S03:** 验证正确性与首屏提速

### Implementation acceptance criteria

- [x] **I-AC01:** 近月结果不等待全年
- [x] **I-AC02:** 补采状态及复用可靠
- [x] **I-AC03:** 性能与隔离有证据

## Deployment

### Deployment steps

- [ ] **D-S01:** 准备可比较的线上验证
- [x] **D-S02:** 经现有流程发布兼容候选
- [ ] **D-S03:** 验证渐进结果与权限边界

### Deployment acceptance criteria

- [ ] **D-AC01:** 线上近月结果提前可用
- [ ] **D-AC02:** 线上补采与恢复有效
- [ ] **D-AC03:** 发布与访问边界正常
