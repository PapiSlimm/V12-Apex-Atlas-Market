import React, { useCallback, useState, useEffect } from 'react';
import { DigitalTwinNode, User, ToastMessage } from '../types';
import { Globe2, FileText, Link2, Edit3, Save, Layers, Server, Package, AlertTriangle, X } from 'lucide-react';
import { api } from '../lib/api';

interface MemoryGalaxyGraphProps {
  user: User | null;
  onOpenAuth: () => void;
  addToast?: (toast: Omit<ToastMessage, 'id' | 'timestamp'>) => void;
}

export const MemoryGalaxyGraph: React.FC<MemoryGalaxyGraphProps> = ({ user, onOpenAuth, addToast }) => {
  const [nodes, setNodes] = useState<DigitalTwinNode[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeNode = nodes.find((n) => n.id === activeId) ?? null;

  const fetchNodes = useCallback(async (preferId?: string) => {
    setError(null);
    try {
      const data = await api.get<{ nodes: DigitalTwinNode[] }>('/api/vault/nodes');
      const list = data.nodes ?? [];
      setNodes(list);
      setActiveId((current) => {
        const target = preferId ?? current;
        const next = target && list.some((n) => n.id === target) ? target : list[0]?.id ?? null;
        const node = list.find((n) => n.id === next);
        // Do not clobber unsaved edits with a refetch.
        setEditContent((prevContent) => (isEditing ? prevContent : node?.content ?? ''));
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the vault.');
    }
    // isEditing intentionally excluded: including it would re-fetch on every
    // edit-mode toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void fetchNodes();
  }, [fetchNodes]);

  const handleSelectNode = (node: DigitalTwinNode) => {
    setActiveId(node.id);
    setEditContent(node.content);
    setIsEditing(false);
    setSaveSuccess(false);
    setError(null);
  };

  const handleSave = async () => {
    if (!activeNode) return;
    if (!user) {
      onOpenAuth();
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await api.put('/api/vault/node', { id: activeNode.id, content: editContent });
      setSaveSuccess(true);
      setIsEditing(false);
      await fetchNodes(activeNode.id);
      addToast?.({
        type: 'success',
        title: 'Vault note saved',
        description: activeNode.filePath,
      });
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed.';
      setError(message);
      addToast?.({ type: 'error', title: 'Save failed', description: message });
    } finally {
      setIsSaving(false);
    }
  };

  const parseWikiLinks = (text: string) => {
    const parts = text.split(/(\[\[.*?\]\])/g);
    return parts.map((part, i) => {
      if (part.startsWith('[[') && part.endsWith(']]')) {
        const nodeName = part.slice(2, -2);
        const matched = nodes.find(
          (n) => n.name.toLowerCase().includes(nodeName.toLowerCase()) || n.id.toLowerCase().includes(nodeName.toLowerCase())
        );
        return (
          <button
            key={i}
            onClick={() => matched && handleSelectNode(matched)}
            className="text-cyan-400 underline font-bold px-1 hover:text-cyan-300 inline-flex items-center space-x-1 bg-cyan-950/40 rounded border border-cyan-500/30 cursor-pointer"
          >
            <Link2 className="w-3 h-3" />
            <span>{nodeName}</span>
          </button>
        );
      }
      return part;
    });
  };

  return (
    <div className="flex-1 p-4 md:p-6 space-y-6 overflow-y-auto font-mono text-zinc-100 bg-zinc-950">
      {/* Top Header: Memory Galaxy Header */}
      <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 md:p-5 shadow-xl backdrop-blur-md">
        <div className="flex items-center space-x-3 mb-2">
          <div className="p-2 rounded-lg bg-indigo-950 border border-indigo-500/40 text-indigo-400">
            <Globe2 className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-base font-bold text-zinc-100">Digital twin vault (Memory Galaxy)</h2>
            <p className="text-xs text-zinc-400 font-sans">
              An interconnected markdown knowledge graph that grounds physical infrastructure — cities,
              factories, warehouses — in something the agents can read and cite.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="p-3 rounded-xl bg-red-950/60 border border-red-600/50 text-red-200 text-xs font-sans flex items-start justify-between gap-3"
        >
          <div className="flex items-start space-x-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error" className="cursor-pointer">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Main Layout: Node Graph Map + Markdown Reader */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Col: Graph Topology Tree */}
        <div className="space-y-4">
          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wide mb-3 flex items-center space-x-2">
              <Layers className="w-4 h-4 text-emerald-400" />
              <span>Digital Twin Graph Topology</span>
            </h3>

            <div className="space-y-2">
              {nodes.map((node) => {
                const isSelected = activeNode?.id === node.id;
                let Icon = Globe2;
                if (node.type === 'factory_node') Icon = Server;
                if (node.type === 'warehouse_node') Icon = Package;

                return (
                  <button
                    key={node.id}
                    onClick={() => handleSelectNode(node)}
                    className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                      isSelected
                        ? 'bg-zinc-950 border-emerald-500 text-emerald-300 shadow-lg shadow-emerald-950/30'
                        : 'bg-zinc-950/60 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-950'
                    }`}
                  >
                    <div className="flex items-center space-x-3 truncate">
                      <div className={`p-1.5 rounded-lg ${isSelected ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-900 text-zinc-500'}`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div className="truncate">
                        <div className="text-xs font-bold truncate">{node.name}</div>
                        <div className="text-[10px] text-zinc-500 font-mono truncate">{node.filePath}</div>
                      </div>
                    </div>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-bold uppercase text-zinc-400">
                      {node.node_id}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Connected Links Map Box */}
          {activeNode && (
            <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-4 shadow-xl">
              <h4 className="text-xs font-bold text-zinc-200 mb-2 flex items-center space-x-1.5">
                <Link2 className="w-3.5 h-3.5 text-cyan-400" />
                <span>WIKI-LINK BACKLINKS</span>
              </h4>
              <div className="flex flex-wrap gap-2 text-xs">
                {activeNode.connectedNodes.map((conn, idx) => (
                  <span key={idx} className="px-2.5 py-1 rounded-lg bg-zinc-950 border border-cyan-500/30 text-cyan-300 flex items-center space-x-1">
                    <span>[[{conn}]]</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right 2 Cols: Markdown Document Reader & Editor */}
        <div className="lg:col-span-2">
          <div className="bg-zinc-900/90 border border-zinc-800 rounded-xl p-5 shadow-2xl flex flex-col h-[560px]">
            {activeNode ? (
              <>
                <div className="flex flex-wrap items-center justify-between pb-3 mb-4 border-b border-zinc-800 gap-2">
                  <div className="flex items-center space-x-2">
                    <FileText className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-bold text-zinc-200">{activeNode.filePath}</span>
                  </div>

                  <div className="flex items-center space-x-2">
                    {saveSuccess && (
                      <span className="text-xs text-emerald-400 font-bold flex items-center space-x-1">
                        ✓ Saved to Vault!
                      </span>
                    )}

                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setIsEditing(false);
                            setEditContent(activeNode.content);
                          }}
                          className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-bold transition-colors cursor-pointer border border-zinc-700"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSave()}
                          disabled={isSaving}
                          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white rounded-lg text-xs font-bold flex items-center space-x-1 transition-colors cursor-pointer"
                        >
                          <Save className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{isSaving ? 'Saving…' : 'Save note'}</span>
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => (user ? setIsEditing(true) : onOpenAuth())}
                        title={user ? 'Edit this note' : 'Sign in to edit vault notes'}
                        className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs font-bold flex items-center space-x-1 transition-colors cursor-pointer border border-zinc-700"
                      >
                        <Edit3 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{user ? 'Edit markdown' : 'Sign in to edit'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    aria-label={`Markdown source for ${activeNode.filePath}`}
                    spellCheck={false}
                    className="flex-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-xs font-mono text-zinc-100 focus:outline-none focus:border-emerald-500 resize-none leading-relaxed"
                  />
                ) : (
                  <div className="flex-1 overflow-y-auto bg-zinc-950 border border-zinc-800/80 rounded-xl p-5 text-xs text-zinc-300 leading-relaxed font-sans whitespace-pre-wrap">
                    {parseWikiLinks(activeNode.content)}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-zinc-500 text-center py-20">Select a node from graph topology</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
