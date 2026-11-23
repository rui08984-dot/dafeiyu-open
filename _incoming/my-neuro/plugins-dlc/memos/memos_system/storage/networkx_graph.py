# networkx_graph.py - 轻量级图存储（替代 Neo4j）
"""
基于 NetworkX 的轻量级图存储
无需安装额外软件，数据持久化到 JSON 文件
"""

import os
import json
import logging
from typing import List, Dict, Any, Optional, Set
from datetime import datetime

try:
    import networkx as nx
    NETWORKX_AVAILABLE = True
except ImportError:
    NETWORKX_AVAILABLE = False

logger = logging.getLogger(__name__)


class NetworkXGraphClient:
    """轻量级图数据库客户端（基于 NetworkX）"""
    
    def __init__(self, data_path: str = "./data/graph_store.json"):
        """
        初始化图客户端
        
        Args:
            data_path: 图数据持久化路径
        """
        self.data_path = data_path
        self.graph = nx.DiGraph()  # 有向图
        self._initialized = False
        
        if not NETWORKX_AVAILABLE:
            logger.warning("NetworkX 不可用")
            return
        
        self._load_graph()
        self._initialized = True
        logger.info(f"图数据库已初始化: {self.get_stats()}")
    
    def _load_graph(self):
        """从文件加载图数据"""
        if os.path.exists(self.data_path):
            try:
                with open(self.data_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                
                # 加载节点
                for node in data.get('nodes', []):
                    node_data = dict(node)
                    node_id = node_data.pop('id')
                    self._normalize_entity_attrs(node_data)
                    self.graph.add_node(node_id, **node_data)
                
                # 加载边
                for edge in data.get('edges', []):
                    edge_attrs = dict(edge)
                    source = edge_attrs.pop('source')
                    target = edge_attrs.pop('target')
                    self._normalize_relation_attrs(edge_attrs)
                    self.graph.add_edge(source, target, **edge_attrs)
                
                logger.info(f"从文件加载图数据: {len(self.graph.nodes)} 节点, {len(self.graph.edges)} 边")
            except Exception as e:
                logger.error(f"加载图数据失败: {e}")
                self.graph = nx.DiGraph()
        else:
            # 确保目录存在
            os.makedirs(os.path.dirname(self.data_path), exist_ok=True)
    
    def _save_graph(self):
        """保存图数据到文件"""
        try:
            data = {
                'nodes': [],
                'edges': [],
                'metadata': {
                    'saved_at': datetime.now().isoformat(),
                    'node_count': len(self.graph.nodes),
                    'edge_count': len(self.graph.edges)
                }
            }
            
            # 保存节点
            for node_id, attrs in self.graph.nodes(data=True):
                node_data = {'id': node_id, **attrs}
                data['nodes'].append(node_data)
            
            # 保存边
            for source, target, attrs in self.graph.edges(data=True):
                edge_data = {
                    'source': source,
                    'target': target,
                    **attrs
                }
                data['edges'].append(edge_data)
            
            # 写入文件（先写同目录临时文件再原子替换：崩溃/备份读取都不会看到半截 JSON）
            os.makedirs(os.path.dirname(self.data_path), exist_ok=True)
            tmp_path = self.data_path + '.tmp'
            with open(tmp_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, self.data_path)

            logger.debug("图数据已保存")
        except Exception as e:
            logger.error(f"保存图数据失败: {e}")

    def _normalize_entity_attrs(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        """Keep frequently queried entity fields at the node top level."""
        properties = attrs.get('properties') or {}
        if not isinstance(properties, dict):
            properties = {}
            attrs['properties'] = properties

        source_memory_ids = attrs.get('source_memory_ids') or properties.get('source_memory_ids') or []
        if isinstance(source_memory_ids, str):
            source_memory_ids = [source_memory_ids]
        attrs['source_memory_ids'] = list(dict.fromkeys(source_memory_ids))

        for field in ('description', 'aliases', 'confidence'):
            if field not in attrs and field in properties:
                attrs[field] = properties.get(field)
        attrs.setdefault('aliases', [])
        attrs.setdefault('confidence', properties.get('confidence', 1.0))
        return attrs

    def _normalize_relation_attrs(self, attrs: Dict[str, Any]) -> Dict[str, Any]:
        """Keep relation metadata available both directly and in properties."""
        properties = attrs.get('properties') or {}
        if not isinstance(properties, dict):
            properties = {}
            attrs['properties'] = properties

        attrs.setdefault('relation_type', attrs.get('type', 'related_to'))
        for field in ('description', 'confidence', 'source_memory_id'):
            if field not in attrs and field in properties:
                attrs[field] = properties.get(field)
        return attrs
    
    def is_available(self) -> bool:
        """检查是否可用"""
        return NETWORKX_AVAILABLE and self._initialized
    
    # ==================== 实体（节点）操作 ====================
    
    def add_entity(
        self,
        entity_id: str,
        entity_type: str,
        name: str,
        properties: Optional[Dict[str, Any]] = None,
        user_id: Optional[str] = None
    ) -> bool:
        """
        添加实体
        
        Args:
            entity_id: 实体唯一 ID
            entity_type: 实体类型（person, place, concept 等）
            name: 实体名称
            properties: 附加属性
            user_id: 所属用户
        """
        if not self.is_available():
            return False
        
        try:
            node_attrs = {
                'entity_type': entity_type,
                'name': name,
                'properties': properties or {},
                'user_id': user_id,
                'created_at': datetime.now().isoformat(),
                'updated_at': datetime.now().isoformat()
            }
            self._normalize_entity_attrs(node_attrs)
            self.graph.add_node(
                entity_id,
                **node_attrs
            )
            self._save_graph()
            logger.debug(f"添加实体: {name} ({entity_type})")
            return True
        except Exception as e:
            logger.error(f"添加实体失败: {e}")
            return False
    
    def get_entity(self, entity_id: str) -> Optional[Dict[str, Any]]:
        """获取实体"""
        if not self.is_available():
            return None
        
        if entity_id in self.graph.nodes:
            data = dict(self.graph.nodes[entity_id])
            data['id'] = entity_id
            return data
        return None
    
    def find_entity_by_name(
        self,
        name: str,
        user_id: Optional[str] = None,
        entity_type: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """按名称查找实体（与 Neo4j 接口一致）
        
        Args:
            name: 实体名称
            user_id: 用户 ID 过滤
            entity_type: 实体类型过滤
            
        Returns:
            找到的第一个匹配实体，或 None
        """
        if not self.is_available():
            return None
        
        name_lower = name.lower()
        
        for node_id, attrs in self.graph.nodes(data=True):
            node_name = attrs.get('name', '').lower()
            
            # 名称匹配（模糊）
            if name_lower in node_name or node_name in name_lower:
                # 用户过滤
                if user_id and attrs.get('user_id') != user_id:
                    continue
                # 类型过滤
                if entity_type and attrs.get('entity_type') != entity_type:
                    continue
                
                return {'id': node_id, **attrs}
        
        return None
    
    def find_entities_by_name(
        self,
        name: str,
        user_id: Optional[str] = None,
        entity_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """按名称查找所有匹配的实体
        
        Args:
            name: 实体名称
            user_id: 用户 ID 过滤
            entity_type: 实体类型过滤
            
        Returns:
            所有匹配的实体列表
        """
        if not self.is_available():
            return []
        
        results = []
        name_lower = name.lower()
        
        for node_id, attrs in self.graph.nodes(data=True):
            node_name = attrs.get('name', '').lower()
            
            # 名称匹配（模糊）
            if name_lower in node_name or node_name in name_lower:
                # 用户过滤
                if user_id and attrs.get('user_id') != user_id:
                    continue
                # 类型过滤
                if entity_type and attrs.get('entity_type') != entity_type:
                    continue
                
                results.append({'id': node_id, **attrs})
        
        return results
    
    def update_entity(
        self,
        entity_id: str,
        properties: Optional[Dict[str, Any]] = None,
        name: Optional[str] = None
    ) -> bool:
        """更新实体"""
        if not self.is_available() or entity_id not in self.graph.nodes:
            return False
        
        try:
            if name:
                self.graph.nodes[entity_id]['name'] = name
            if properties:
                existing = self.graph.nodes[entity_id].get('properties', {})
                existing.update(properties)
                self.graph.nodes[entity_id]['properties'] = existing
            
            self.graph.nodes[entity_id]['updated_at'] = datetime.now().isoformat()
            self._save_graph()
            return True
        except Exception as e:
            logger.error(f"更新实体失败: {e}")
            return False
    
    def delete_entity(self, entity_id: str) -> bool:
        """删除实体（同时删除相关的边）"""
        if not self.is_available() or entity_id not in self.graph.nodes:
            return False
        
        try:
            self.graph.remove_node(entity_id)
            self._save_graph()
            logger.debug(f"删除实体: {entity_id}")
            return True
        except Exception as e:
            logger.error(f"删除实体失败: {e}")
            return False
    
    def list_entities(
        self,
        user_id: Optional[str] = None,
        entity_type: Optional[str] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """列出实体
        
        Args:
            user_id: 用户 ID 过滤（与 Neo4j 接口一致）
            entity_type: 实体类型过滤
            limit: 返回数量限制
        """
        if not self.is_available():
            return []
        
        results = []
        for node_id, attrs in self.graph.nodes(data=True):
            if user_id and attrs.get('user_id') != user_id:
                continue
            if entity_type and attrs.get('entity_type') != entity_type:
                continue
            
            results.append({'id': node_id, **attrs})
            if len(results) >= limit:
                break
        
        return results
    
    def list_all_relations(
        self,
        user_id: str = "",
        limit: int = 500
    ) -> List[Dict[str, Any]]:
        """列出所有关系（用于图谱可视化）
        
        Args:
            user_id: 用户 ID（空字符串时返回所有关系）
            limit: 返回数量限制
        
        Returns:
            关系列表，每个包含 source_id, target_id, relation_type
        """
        if not self.is_available():
            return []
        
        relations = []
        for source, target, attrs in self.graph.edges(data=True):
            # 如果指定了 user_id，检查源和目标节点的 user_id
            if user_id:
                source_attrs = self.graph.nodes.get(source, {})
                target_attrs = self.graph.nodes.get(target, {})
                if source_attrs.get('user_id') != user_id or target_attrs.get('user_id') != user_id:
                    continue
            
            relation_type = attrs.get('relation_type', 'related_to')
            relations.append({
                'source_id': source,
                'target_id': target,
                'relation_type': relation_type,
                'type': relation_type,
                'properties': attrs.get('properties', {}),
                'source_memory_id': attrs.get('source_memory_id') or attrs.get('properties', {}).get('source_memory_id'),
                'created_at': attrs.get('created_at')
            })
            
            if len(relations) >= limit:
                break
        
        return relations
    
    # ==================== 关系（边）操作 ====================
    
    def add_relation(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        properties: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        添加关系
        
        Args:
            source_id: 源实体 ID
            target_id: 目标实体 ID
            relation_type: 关系类型（likes, works_at, knows 等）
            properties: 关系属性
        """
        if not self.is_available():
            return False
        
        # 确保两个节点都存在
        if source_id not in self.graph.nodes or target_id not in self.graph.nodes:
            logger.warning(f"添加关系失败: 节点不存在")
            return False
        
        try:
            edge_attrs = {
                'relation_type': relation_type,
                'properties': properties or {},
                'created_at': datetime.now().isoformat()
            }
            self._normalize_relation_attrs(edge_attrs)
            self.graph.add_edge(
                source_id,
                target_id,
                **edge_attrs
            )
            self._save_graph()
            logger.debug(f"添加关系: {source_id} -[{relation_type}]-> {target_id}")
            return True
        except Exception as e:
            logger.error(f"添加关系失败: {e}")
            return False
    
    def get_relations(
        self,
        entity_id: str,
        direction: str = "both",
        relation_type: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        获取实体的关系
        
        Args:
            entity_id: 实体 ID
            direction: 方向 (out, in, both)
            relation_type: 关系类型过滤
        """
        if not self.is_available() or entity_id not in self.graph.nodes:
            return []
        
        relations = []
        
        # 出边
        if direction in ("out", "both"):
            for _, target, attrs in self.graph.out_edges(entity_id, data=True):
                if relation_type and attrs.get('relation_type') != relation_type:
                    continue
                relations.append({
                    'source': entity_id,
                    'target': target,
                    'direction': 'out',
                    **attrs
                })
        
        # 入边
        if direction in ("in", "both"):
            for source, _, attrs in self.graph.in_edges(entity_id, data=True):
                if relation_type and attrs.get('relation_type') != relation_type:
                    continue
                relations.append({
                    'source': source,
                    'target': entity_id,
                    'direction': 'in',
                    **attrs
                })
        
        return relations
    
    def delete_relation(
        self,
        source_id: str,
        target_id: str,
        relation_type: Optional[str] = None
    ) -> bool:
        """删除关系
        
        Args:
            source_id: 源实体 ID
            target_id: 目标实体 ID
            relation_type: 关系类型（可选，不指定则删除所有关系）
        """
        if not self.is_available():
            return False
        
        try:
            if self.graph.has_edge(source_id, target_id):
                # 如果指定了关系类型，检查是否匹配
                if relation_type:
                    edge_data = self.graph.edges[source_id, target_id]
                    if edge_data.get('relation_type') != relation_type:
                        return False
                
                self.graph.remove_edge(source_id, target_id)
                self._save_graph()
                return True
            return False
        except Exception as e:
            logger.error(f"删除关系失败: {e}")
            return False
    
    def get_memory_entities(self, memory_id: str) -> List[Dict[str, Any]]:
        """获取记忆关联的实体列表
        
        Args:
            memory_id: 记忆 ID
        
        Returns:
            关联的实体列表
        """
        if not self.is_available():
            return []
        
        entities = []
        
        for node_id, attrs in self.graph.nodes(data=True):
            self._normalize_entity_attrs(attrs)
            source_memory_ids = attrs.get('source_memory_ids', [])
            if memory_id in source_memory_ids:
                entities.append({'id': node_id, **attrs})
        
        return entities
    
    # ==================== 图查询 ====================
    
    def find_related_entities(
        self,
        entity_id: str,
        max_depth: int = 2,
        relation_types: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """
        查找相关实体（多跳查询）
        
        Args:
            entity_id: 起始实体 ID
            max_depth: 最大深度
            relation_types: 关系类型过滤
        """
        if not self.is_available() or entity_id not in self.graph.nodes:
            return []
        
        visited: Set[str] = {entity_id}
        results = []
        current_level = [entity_id]
        
        for depth in range(1, max_depth + 1):
            next_level = []
            
            for node in current_level:
                # 出边邻居
                for neighbor in self.graph.successors(node):
                    if neighbor in visited:
                        continue
                    
                    edge_data = self.graph.edges[node, neighbor]
                    if relation_types and edge_data.get('relation_type') not in relation_types:
                        continue
                    
                    visited.add(neighbor)
                    next_level.append(neighbor)
                    
                    node_data = dict(self.graph.nodes[neighbor])
                    node_data['id'] = neighbor
                    node_data['depth'] = depth
                    node_data['path_relation'] = edge_data.get('relation_type')
                    results.append(node_data)
                
                # 入边邻居
                for neighbor in self.graph.predecessors(node):
                    if neighbor in visited:
                        continue
                    
                    edge_data = self.graph.edges[neighbor, node]
                    if relation_types and edge_data.get('relation_type') not in relation_types:
                        continue
                    
                    visited.add(neighbor)
                    next_level.append(neighbor)
                    
                    node_data = dict(self.graph.nodes[neighbor])
                    node_data['id'] = neighbor
                    node_data['depth'] = depth
                    node_data['path_relation'] = edge_data.get('relation_type')
                    results.append(node_data)
            
            current_level = next_level
            if not current_level:
                break
        
        return results
    
    def find_path(
        self,
        source_id: str,
        target_id: str,
        max_length: int = 5
    ) -> Optional[List[Dict[str, Any]]]:
        """
        查找两个实体之间的路径
        
        Args:
            source_id: 起始实体
            target_id: 目标实体
            max_length: 最大路径长度
        """
        if not self.is_available():
            return None
        
        if source_id not in self.graph.nodes or target_id not in self.graph.nodes:
            return None
        
        try:
            # 使用无向图版本查找路径
            undirected = self.graph.to_undirected()
            path = nx.shortest_path(undirected, source_id, target_id)
            
            if len(path) > max_length + 1:
                return None
            
            # 构建路径详情
            result = []
            for i, node_id in enumerate(path):
                node_data = dict(self.graph.nodes[node_id])
                node_data['id'] = node_id
                node_data['step'] = i
                
                # 添加到下一节点的关系
                if i < len(path) - 1:
                    next_id = path[i + 1]
                    if self.graph.has_edge(node_id, next_id):
                        node_data['next_relation'] = self.graph.edges[node_id, next_id].get('relation_type')
                    elif self.graph.has_edge(next_id, node_id):
                        node_data['next_relation'] = self.graph.edges[next_id, node_id].get('relation_type') + ' (反向)'
                
                result.append(node_data)
            
            return result
        except nx.NetworkXNoPath:
            return None
        except Exception as e:
            logger.error(f"查找路径失败: {e}")
            return None
    
    def search_by_entities(
        self,
        entity_names: List[str],
        user_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        根据实体名称搜索相关内容
        
        Args:
            entity_names: 实体名称列表
            user_id: 用户 ID
        """
        if not self.is_available():
            return []
        
        # 找到匹配的实体（使用 find_entities_by_name 获取所有匹配）
        matched_entities = []
        for name in entity_names:
            entities = self.find_entities_by_name(name, user_id=user_id)
            matched_entities.extend(entities)
        
        # 获取所有相关实体
        all_related = []
        seen_ids = set()
        
        for entity in matched_entities:
            if entity['id'] in seen_ids:
                continue
            seen_ids.add(entity['id'])
            all_related.append(entity)
            
            # 获取一跳相关
            related = self.find_related_entities(entity['id'], max_depth=1)
            for r in related:
                if r['id'] not in seen_ids:
                    seen_ids.add(r['id'])
                    all_related.append(r)
        
        return all_related
    
    def get_entity_memories(self, entity_id: str) -> List[str]:
        """获取实体关联的记忆 ID
        
        Args:
            entity_id: 实体 ID
        
        Returns:
            记忆 ID 列表
        """
        if not self.is_available() or entity_id not in self.graph.nodes:
            return []
        
        # 从实体节点的 source_memory_ids 属性获取
        entity_data = self.graph.nodes[entity_id]
        self._normalize_entity_attrs(entity_data)
        memory_ids = entity_data.get('source_memory_ids', [])
        
        # 也检查关系中的 source_memory_id
        for _, _, attrs in self.graph.edges(entity_id, data=True):
            self._normalize_relation_attrs(attrs)
            mem_id = attrs.get('source_memory_id')
            if mem_id and mem_id not in memory_ids:
                memory_ids.append(mem_id)
        
        for _, _, attrs in self.graph.in_edges(entity_id, data=True):
            self._normalize_relation_attrs(attrs)
            mem_id = attrs.get('source_memory_id')
            if mem_id and mem_id not in memory_ids:
                memory_ids.append(mem_id)
        
        return memory_ids

    # ==================== 一致性检查 / 死引用清理（B3） ====================
    # 只回答「图里引用的记忆还在不在」；不删记忆、不删向量、不碰 BM25。
    # 实体节点把 source_memory_ids 同时存在顶层和 properties（历史双份），
    # 这里一律读两份的并集，清理时两份一起写，否则下次 _normalize_entity_attrs
    # 会把 properties 里的死 id 又提回顶层。

    @staticmethod
    def _id_prefix(value: Any, limit: int = 8) -> str:
        return str(value or '')[:max(1, int(limit or 8))]

    @staticmethod
    def _entity_ref_lists(attrs: Dict[str, Any]) -> Dict[str, List[str]]:
        """不修改节点属性，取出顶层 / properties 两份 source_memory_ids。"""
        def _as_list(raw: Any) -> List[str]:
            if raw is None:
                return []
            if isinstance(raw, str):
                raw = [raw]
            if not isinstance(raw, (list, tuple, set)):
                return []
            return list(dict.fromkeys(str(item) for item in raw if item is not None))

        top_raw = attrs.get('source_memory_ids')
        props = attrs.get('properties')
        props_raw = props.get('source_memory_ids') if isinstance(props, dict) else None
        top = _as_list(top_raw)
        prop = _as_list(props_raw)
        return {'top': top, 'props': prop, 'merged': list(dict.fromkeys(top + prop))}

    @staticmethod
    def _relation_memory_ref(attrs: Dict[str, Any]) -> Optional[str]:
        raw = attrs.get('source_memory_id')
        if raw is None:
            props = attrs.get('properties')
            if isinstance(props, dict):
                raw = props.get('source_memory_id')
        return None if raw is None else str(raw)

    def analyze_consistency(
        self,
        existing_memory_ids,
        user_id: Optional[str] = None,
        sample_limit: int = 5
    ) -> Dict[str, Any]:
        """只读统计：死引用 / 无来源实体 / 顶层与 properties 双份不一致。

        Args:
            existing_memory_ids: 现存记忆 id 集合。调用方决定是否包含软删除/归档
                （包含时它们不算“死”）。
            user_id: 只统计该用户的实体（None = 全部用户）。
            sample_limit: 每类示例最多返回几个 id 前缀。

        Returns:
            计数 + 只含 id 前缀的 samples；不修改图。
        """
        if not self.is_available():
            return {'available': False, 'entity_count': 0, 'relation_count': 0}

        sample_limit = max(1, int(sample_limit or 5))
        existing = {str(item) for item in (existing_memory_ids or []) if item is not None}

        entity_count = 0
        relation_count = 0
        dead_reference_count = 0
        dead_entity_count = 0
        dead_only_entity_count = 0
        orphan_entity_count = 0
        props_mismatch_count = 0
        edge_dead_reference_count = 0

        dead_entity_ids: List[str] = []
        dead_only_entity_ids: List[str] = []
        orphan_entity_ids: List[str] = []
        mismatch_entity_ids: List[str] = []
        dead_memory_ids: set = set()
        ref_owners: Dict[str, set] = {}
        scope_nodes: set = set()

        for node_id, attrs in self.graph.nodes(data=True):
            if user_id and attrs.get('user_id') != user_id:
                continue
            scope_nodes.add(node_id)
            entity_count += 1

            refs = self._entity_ref_lists(attrs)
            merged = refs['merged']
            if not merged:
                orphan_entity_count += 1
                if len(orphan_entity_ids) < sample_limit:
                    orphan_entity_ids.append(self._id_prefix(node_id, 8))
            else:
                dead = [mid for mid in merged if mid not in existing]
                live = [mid for mid in merged if mid in existing]
                if dead:
                    dead_reference_count += len(dead)
                    dead_entity_count += 1
                    dead_memory_ids.update(dead)
                    if len(dead_entity_ids) < sample_limit:
                        dead_entity_ids.append(self._id_prefix(node_id, 8))
                    if not live:
                        dead_only_entity_count += 1
                        if len(dead_only_entity_ids) < sample_limit:
                            dead_only_entity_ids.append(self._id_prefix(node_id, 8))
                for memory_id in live:
                    ref_owners.setdefault(memory_id, set()).add(node_id)

            if set(refs['top']) != set(refs['props']):
                props_mismatch_count += 1
                if len(mismatch_entity_ids) < sample_limit:
                    mismatch_entity_ids.append(self._id_prefix(node_id, 8))

        edge_dead_entity_ids: List[str] = []
        for source, _target, attrs in self.graph.edges(data=True):
            if user_id and source not in scope_nodes:
                continue
            relation_count += 1
            memory_id = self._relation_memory_ref(attrs)
            if memory_id is not None and memory_id not in existing:
                edge_dead_reference_count += 1
                if len(edge_dead_entity_ids) < sample_limit:
                    edge_dead_entity_ids.append(self._id_prefix(source, 8))

        return {
            'available': True,
            'entity_count': entity_count,
            'relation_count': relation_count,
            'referenced_memory_count': len(ref_owners),
            'dead_reference_count': dead_reference_count,
            'dead_entity_count': dead_entity_count,
            'dead_only_entity_count': dead_only_entity_count,
            'orphan_entity_count': orphan_entity_count,
            'props_mismatch_count': props_mismatch_count,
            'edge_dead_reference_count': edge_dead_reference_count,
            'multi_entity_memory_count': sum(1 for owners in ref_owners.values() if len(owners) > 1),
            'samples': {
                'dead_entity_ids': dead_entity_ids,
                'dead_only_entity_ids': dead_only_entity_ids,
                'orphan_entity_ids': orphan_entity_ids,
                'props_mismatch_entity_ids': mismatch_entity_ids,
                'dead_memory_ids': sorted(self._id_prefix(mid, 8) for mid in dead_memory_ids)[:sample_limit],
                'edge_dead_entity_ids': edge_dead_entity_ids,
            }
        }

    def cleanup_dead_references(
        self,
        existing_memory_ids,
        user_id: Optional[str] = None,
        dry_run: bool = True,
        repair_dual_store: bool = True
    ) -> Dict[str, Any]:
        """安全清理图里的死引用（默认只演练）。

        语义（只动图 JSON，不删记忆/向量/BM25）：
          1. 从顶层与 properties 两份 source_memory_ids 中摘掉不存在的记忆；
          2. 没有死引用但两份不一致时，用并集统一两份（不丢活引用）；
          3. 实体曾引用死记忆、清理后不再剩任何来源 → 删节点（连带边）；
          4. 边上的 source_memory_id 指向不存在记忆 → 摘掉该字段，边本身保留；
          5. 无来源且从未引用过死记忆的孤儿实体保持原样（可能是人工建的）。
        一次批量修改后走 _save_graph() 原子落盘；幂等（第二次 0 变化）。
        """
        existing = {str(item) for item in (existing_memory_ids or []) if item is not None}
        before = self.analyze_consistency(existing, user_id=user_id)
        changes = {
            'refs_removed': 0,
            'entities_deleted': 0,
            'entities_repaired': 0,
            'edge_refs_cleared': 0,
        }
        changed = False
        scope_nodes: set = set()

        for node_id, attrs in list(self.graph.nodes(data=True)):
            if user_id and attrs.get('user_id') != user_id:
                continue
            scope_nodes.add(node_id)

            refs = self._entity_ref_lists(attrs)
            merged, top, props = refs['merged'], refs['top'], refs['props']
            dead = [mid for mid in merged if mid not in existing]
            live = [mid for mid in merged if mid in existing]
            dual_mismatch = set(top) != set(props)

            if not dead and not (repair_dual_store and dual_mismatch):
                continue
            changed = True
            changes['refs_removed'] += len(dead)

            # 只有死引用的实体：原本就是死记忆的产物，清理后连节点带边删除。
            if dead and not live:
                changes['entities_deleted'] += 1
                if not dry_run:
                    self.graph.remove_node(node_id)
                continue

            if dual_mismatch or dead:
                changes['entities_repaired'] += 1
            if not dry_run:
                attrs['source_memory_ids'] = list(live)
                properties = attrs.get('properties')
                if not isinstance(properties, dict):
                    properties = {}
                    attrs['properties'] = properties
                properties['source_memory_ids'] = list(live)

        for source, _target, attrs in list(self.graph.edges(data=True)):
            if user_id and source not in scope_nodes:
                continue
            memory_id = self._relation_memory_ref(attrs)
            if memory_id is None or memory_id in existing:
                continue
            changes['edge_refs_cleared'] += 1
            changed = True
            if not dry_run:
                attrs.pop('source_memory_id', None)
                properties = attrs.get('properties')
                if isinstance(properties, dict):
                    properties.pop('source_memory_id', None)

        saved = False
        if changed and not dry_run:
            self._save_graph()
            saved = True

        after = before if dry_run else self.analyze_consistency(existing, user_id=user_id)
        return {
            'available': True,
            'dry_run': bool(dry_run),
            'changed': bool(changed),
            'saved': saved,
            'existing_memory_count': len(existing),
            'changes': changes,
            'before': before,
            'after': after,
        }
    
    def link_entity_to_memory(
        self,
        entity_id: str,
        memory_id: str
    ) -> bool:
        """将实体关联到记忆
        
        Args:
            entity_id: 实体 ID
            memory_id: 记忆 ID
        
        Returns:
            是否成功
        """
        if not self.is_available() or entity_id not in self.graph.nodes:
            return False
        
        try:
            # 获取当前的 source_memory_ids
            self._normalize_entity_attrs(self.graph.nodes[entity_id])
            current_ids = self.graph.nodes[entity_id].get('source_memory_ids', [])
            
            if memory_id not in current_ids:
                current_ids.append(memory_id)
                self.graph.nodes[entity_id]['source_memory_ids'] = current_ids
                self._save_graph()
            
            return True
        except Exception as e:
            logger.error(f"关联实体到记忆失败: {e}")
            return False

    def unlink_entity_from_memory(self, entity_id: str, memory_id: str) -> bool:
        """把一条记忆从实体的 source_memory_ids 里摘掉（硬删除记忆后清图谱用）。

        注意顶层与 properties 里各存了一份（_normalize_entity_attrs 会把
        properties 的值提升到顶层），只改其中一份会被下一次读取覆盖回去。
        """
        if not self.is_available() or entity_id not in self.graph.nodes:
            return False
        try:
            attrs = self.graph.nodes[entity_id]
            self._normalize_entity_attrs(attrs)
            attrs['source_memory_ids'] = [
                mid for mid in attrs.get('source_memory_ids', []) if mid != memory_id
            ]
            props = attrs.get('properties')
            if isinstance(props, dict) and 'source_memory_ids' in props:
                raw = props.get('source_memory_ids') or []
                if isinstance(raw, str):
                    raw = [raw]
                props['source_memory_ids'] = [mid for mid in raw if mid != memory_id]
            self._save_graph()
            return True
        except Exception as e:
            logger.error(f"解除实体记忆关联失败: {e}")
            return False
    
    def get_memories_by_entities(
        self,
        entity_ids: List[str]
    ) -> List[str]:
        """获取多个实体关联的所有记忆 ID
        
        Args:
            entity_ids: 实体 ID 列表
        
        Returns:
            去重的记忆 ID 列表
        """
        memory_ids = set()
        
        for entity_id in entity_ids:
            entity_memories = self.get_entity_memories(entity_id)
            memory_ids.update(entity_memories)
        
        return list(memory_ids)
    
    # ==================== 统计 ====================
    
    def get_stats(self, user_id: Optional[str] = None) -> Dict[str, Any]:
        """获取图统计信息
        
        Args:
            user_id: 用户 ID 过滤（与 Neo4j 接口一致）
        """
        if not self.is_available():
            return {'available': False}
        
        # 统计实体类型
        entity_types = {}
        entity_count = 0
        for _, attrs in self.graph.nodes(data=True):
            # 用户过滤
            if user_id and attrs.get('user_id') != user_id:
                continue
            
            entity_count += 1
            etype = attrs.get('entity_type', 'unknown')
            entity_types[etype] = entity_types.get(etype, 0) + 1
        
        # 统计关系类型
        relation_types = {}
        relation_count = 0
        for source, target, attrs in self.graph.edges(data=True):
            # 用户过滤（检查源节点或目标节点是否属于该用户）
            if user_id:
                source_user = self.graph.nodes.get(source, {}).get('user_id')
                target_user = self.graph.nodes.get(target, {}).get('user_id')
                if source_user != user_id and target_user != user_id:
                    continue
            
            relation_count += 1
            rtype = attrs.get('relation_type', 'unknown')
            relation_types[rtype] = relation_types.get(rtype, 0) + 1
        
        return {
            'available': True,
            'entity_count': entity_count if user_id else len(self.graph.nodes),
            'relation_count': relation_count if user_id else len(self.graph.edges),
            'entity_types': entity_types,
            'relation_types': relation_types
        }
    
    # ==================== Neo4j 兼容方法 ====================
    # 以下方法是为了与 Neo4j 客户端接口保持一致
    
    def create_entity(
        self,
        entity_id: str,
        name: str,
        entity_type: str,
        user_id: str,
        properties: Optional[Dict[str, Any]] = None
    ) -> bool:
        """创建实体（Neo4j 兼容接口）"""
        return self.add_entity(
            entity_id=entity_id,
            entity_type=entity_type,
            name=name,
            properties=properties,
            user_id=user_id
        )
    
    def create_relation(
        self,
        source_id: str,
        target_id: str,
        relation_type: str,
        properties: Optional[Dict[str, Any]] = None
    ) -> bool:
        """创建关系（Neo4j 兼容接口）"""
        return self.add_relation(
            source_id=source_id,
            target_id=target_id,
            relation_type=relation_type,
            properties=properties
        )

    # ==================== Memory-node style compatibility ====================

    def add_node(self, node_id: str, metadata: Optional[Dict[str, Any]] = None, **kwargs) -> bool:
        """Add a generic graph node using the local entity schema."""
        metadata = {**(metadata or {}), **kwargs}
        return self.add_entity(
            entity_id=node_id,
            entity_type=metadata.get('entity_type') or metadata.get('type') or 'memory',
            name=metadata.get('name') or metadata.get('content') or node_id,
            properties=metadata,
            user_id=metadata.get('user_id')
        )

    def update_node(self, node_id: str, metadata: Dict[str, Any]) -> bool:
        return self.update_entity(node_id, properties=metadata, name=metadata.get('name'))

    def delete_node(self, node_id: str) -> bool:
        return self.delete_entity(node_id)

    def get_node(self, node_id: str) -> Optional[Dict[str, Any]]:
        return self.get_entity(node_id)

    def get_nodes(self, user_id: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
        return self.list_entities(user_id=user_id, limit=limit)

    def add_edge(self, source_id: str, target_id: str, relation_type: str = 'related_to', metadata: Optional[Dict[str, Any]] = None) -> bool:
        return self.add_relation(source_id, target_id, relation_type, metadata)

    def delete_edge(self, source_id: str, target_id: str, relation_type: Optional[str] = None) -> bool:
        return self.delete_relation(source_id, target_id, relation_type)

    def edge_exists(self, source_id: str, target_id: str, relation_type: Optional[str] = None) -> bool:
        if not self.is_available() or not self.graph.has_edge(source_id, target_id):
            return False
        if relation_type:
            return self.graph.edges[source_id, target_id].get('relation_type') == relation_type
        return True

    def get_neighbors(self, node_id: str, max_depth: int = 1) -> List[Dict[str, Any]]:
        return self.find_related_entities(node_id, max_depth=max_depth)

    def get_path(self, source_id: str, target_id: str, max_length: int = 5) -> Optional[List[Dict[str, Any]]]:
        return self.find_path(source_id, target_id, max_length=max_length)

    def get_subgraph(self, node_ids: Optional[List[str]] = None, max_depth: int = 1) -> Dict[str, Any]:
        if not self.is_available():
            return {'nodes': [], 'edges': []}
        selected = set(node_ids or [])
        for node_id in list(selected):
            for related in self.find_related_entities(node_id, max_depth=max_depth):
                selected.add(related['id'])
        nodes = [self.get_entity(node_id) for node_id in selected if self.get_entity(node_id)]
        edges = []
        for source, target, attrs in self.graph.edges(data=True):
            if source in selected and target in selected:
                relation_type = attrs.get('relation_type', 'related_to')
                edges.append({
                    'source_id': source,
                    'target_id': target,
                    'relation_type': relation_type,
                    'type': relation_type,
                    'properties': attrs.get('properties', {})
                })
        return {'nodes': nodes, 'edges': edges}

    def search_by_embedding(self, *args, **kwargs) -> List[Dict[str, Any]]:
        return []

    def get_by_metadata(self, filters: Dict[str, Any], limit: int = 100) -> List[Dict[str, Any]]:
        if not self.is_available():
            return []
        results = []
        for node_id, attrs in self.graph.nodes(data=True):
            if all(attrs.get(k) == v or attrs.get('properties', {}).get(k) == v for k, v in filters.items()):
                results.append({'id': node_id, **attrs})
                if len(results) >= limit:
                    break
        return results

    def export_graph(self) -> Dict[str, Any]:
        return {
            'nodes': [{'id': node_id, **attrs} for node_id, attrs in self.graph.nodes(data=True)],
            'edges': [{'source': source, 'target': target, **attrs} for source, target, attrs in self.graph.edges(data=True)]
        }

    def import_graph(self, data: Dict[str, Any], merge: bool = True) -> bool:
        if not self.is_available():
            return False
        if not merge:
            self.graph.clear()
        for node in data.get('nodes', []):
            node_data = dict(node)
            node_id = node_data.pop('id')
            self._normalize_entity_attrs(node_data)
            self.graph.add_node(node_id, **node_data)
        for edge in data.get('edges', []):
            edge_data = dict(edge)
            source = edge_data.pop('source')
            target = edge_data.pop('target')
            self._normalize_relation_attrs(edge_data)
            if source in self.graph.nodes and target in self.graph.nodes:
                self.graph.add_edge(source, target, **edge_data)
        self._save_graph()
        return True
    
    def link_memory_to_entity(
        self,
        memory_id: str,
        entity_id: str
    ) -> bool:
        """将记忆关联到实体（Neo4j 兼容接口）"""
        return self.link_entity_to_memory(entity_id, memory_id)
    
    def get_entity_context(self, entity_id: str) -> Dict[str, Any]:
        """获取实体上下文
        
        Args:
            entity_id: 实体 ID
        
        Returns:
            包含实体信息、关系和相关记忆的上下文
        """
        if not self.is_available() or entity_id not in self.graph.nodes:
            return {}
        
        entity = self.get_entity(entity_id)
        if not entity:
            return {}
        
        # 获取关系
        relations = self.get_relations(entity_id, direction="both")
        
        # 获取关联的记忆
        memory_ids = self.get_entity_memories(entity_id)
        
        # 获取相关实体（1 跳）
        related = self.find_related_entities(entity_id, max_depth=1)
        
        return {
            'entity': entity,
            'relations': relations,
            'memory_ids': memory_ids,
            'related_entities': related
        }
    
    def close(self):
        """关闭（保存数据）"""
        self._save_graph()
        logger.info("图数据库已关闭")


# 兼容 Neo4j 接口的别名
MemosNeo4jClient = NetworkXGraphClient
