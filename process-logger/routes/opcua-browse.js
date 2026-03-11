/**
 * Verbesserte Browse-Route mit robustem NodeClass-Handling, BrowseNext-Unterstützung
 * und DataType-Auflösung für menschenlesbare Anzeige.
 */
const express = require('express');
const router = express.Router();
const { OPCUAClient, AttributeIds, MessageSecurityMode, SecurityPolicy } = require('node-opcua');

// NodeClass enum mapping (OPC UA)
const NODECLASS_MAP = {
  unspecified: 0,
  object: 1,
  variable: 2,
  method: 4,
  objecttype: 8,
  variabletype: 16,
  referencetype: 32,
  datatype: 64,
  view: 128
};

// Map für häufige BuiltInType NodeIds (ns=0;i=<id>)
const BUILTIN_MAP = {
  1: 'Boolean',
  2: 'SByte',
  3: 'Byte',
  4: 'Int16',
  5: 'UInt16',
  6: 'Int32',
  7: 'UInt32',
  8: 'Int64',
  9: 'UInt64',
  10: 'Float',
  11: 'Double',
  12: 'String',
  13: 'DateTime',
  14: 'Guid',
  15: 'ByteString',
  16: 'XmlElement',
  17: 'NodeId',
  18: 'ExpandedNodeId',
  19: 'StatusCode',
  20: 'QualifiedName',
  21: 'LocalizedText',
  22: 'Structure',
  23: 'Number',
  24: 'Integer',
  25: 'UInteger'
};

function policyFromArg(p) {
  if (!p) return SecurityPolicy.None;
  const s = String(p);
  if (/none/i.test(s)) return SecurityPolicy.None;
  if (/basic256sha256/i.test(s)) return SecurityPolicy.Basic256Sha256;
  if (/basic256/i.test(s)) return SecurityPolicy.Basic256;
  if (/basic128/i.test(s)) return SecurityPolicy.Basic128Rsa15;
  return SecurityPolicy.None;
}

function normalizeArray(a) {
  if (a === undefined || a === null) return null;
  if (Array.isArray(a)) return a;
  return [a];
}

function nodeClassToNumber(nc) {
  if (nc === undefined || nc === null) return null;
  if (typeof nc === 'number') return nc;
  if (typeof nc === 'object' && nc.value !== undefined && typeof nc.value === 'number') return nc.value;
  const parsed = parseInt(String(nc), 10);
  if (!isNaN(parsed)) return parsed;
  const s = String(nc).toLowerCase();
  if (NODECLASS_MAP[s] !== undefined) return NODECLASS_MAP[s];
  for (const key of Object.keys(NODECLASS_MAP)) {
    if (s.indexOf(key) !== -1) return NODECLASS_MAP[key];
  }
  return null;
}

function nodeIdStringToBuiltinName(nodeIdStr) {
  if (!nodeIdStr) return '';
  const m = String(nodeIdStr).match(/i=(\d+)/);
  if (m) {
    const id = Number(m[1]);
    if (BUILTIN_MAP[id]) return BUILTIN_MAP[id];
    return `i=${id}`;
  }
  const ms = String(nodeIdStr).match(/s=([^;]+)/);
  if (ms) return ms[1];
  return String(nodeIdStr);
}

function displayNameText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    return String(v.text || v.value || v.name || '');
  }
  return String(v);
}

function sortReferencesStable(refs) {
  return (Array.isArray(refs) ? refs.slice() : []).sort((a, b) => {
    const aName = displayNameText(a && a.displayName) || displayNameText(a && a.browseName) || (a && a.nodeId ? String(a.nodeId) : '');
    const bName = displayNameText(b && b.displayName) || displayNameText(b && b.browseName) || (b && b.nodeId ? String(b.nodeId) : '');
    return aName.localeCompare(bName, 'de', { sensitivity: 'base' });
  });
}

router.post('/browse', async (req, res) => {
  const body = req.body || {};
  const { endpoint, username, password, securityPolicy } = body;
  const startNodeId = body.startNodeId || 'ObjectsFolder';
  const maxDepth = Number(body.maxDepth || 2);
  const maxNodes = Number(body.maxNodes || 5000);
  const nodeClassFilter = normalizeArray(body.nodeClass); // e.g. ['Variable'] or [2]
  const dataTypesFilter = normalizeArray(body.dataTypes); // e.g. ['Double','Int32']
  const displayNameContains = body.displayNameContains ? String(body.displayNameContains).toLowerCase() : null;
  // namespace optional: null => search all namespaces
  const namespaceFilter = (body.namespace !== undefined && body.namespace !== null && body.namespace !== '') ? Number(body.namespace) : null;
  const includeValue = !!body.includeValue;

  if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });

  let normalizedNodeClassFilter = null;
  if (nodeClassFilter) {
    normalizedNodeClassFilter = nodeClassFilter.map(f => {
      const num = nodeClassToNumber(f);
      return num !== null ? num : String(f).toLowerCase();
    });
  }

  const isNone = String(securityPolicy || 'None').toLowerCase() === 'none';
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityPolicy: policyFromArg(securityPolicy),
    securityMode: isNone ? MessageSecurityMode.None : MessageSecurityMode.SignAndEncrypt,
    connectionStrategy: { maxRetry: 0 }
  });

  let session;
  try {
    await client.connect(endpoint);
    session = await client.createSession(username ? { userName: username, password } : null);

    const result = [];
    let visited = 0;
    const emittedNodeIds = new Set();
    const traversedNodeIds = new Set();

    // Check filters using raw ref and enriched node (if present)
    function passesFilters(ref, node) {
      if (normalizedNodeClassFilter) {
        const refNc = nodeClassToNumber(ref.nodeClass);
        const okNc = normalizedNodeClassFilter.some(f => {
          if (typeof f === 'number') return refNc === f;
          return String(f).toLowerCase() === String(ref.nodeClass).toLowerCase();
        });
        if (!okNc) return false;
      }

      if (namespaceFilter != null && ref.nodeId) {
        const m = String(ref.nodeId).match(/ns=(\d+);/);
        if (!m || Number(m[1]) !== Number(namespaceFilter)) return false;
      }

      if (dataTypesFilter && node && node.dataType) {
        const dt = String(node.dataType || '').toLowerCase();
        const ok = dataTypesFilter.some(f => String(f).toLowerCase() === dt);
        if (!ok) return false;
      }

      const dn = String((node && node.displayName) || (ref.displayName && (ref.displayName.text || ref.displayName.value || ref.displayName)) || '').toLowerCase();
      if (displayNameContains) {
        if (!dn.includes(displayNameContains)) return false;
      }

      return true;
    }

    async function enrichNode(nodeRef, parentNodeId, depth) {
      const node = {
        nodeId: nodeRef.nodeId && nodeRef.nodeId.toString(),
        browseName: nodeRef.browseName && nodeRef.browseName.toString(),
        displayName: nodeRef.displayName && (nodeRef.displayName.text || nodeRef.displayName.value || nodeRef.displayName),
        nodeClass: nodeRef.nodeClass !== undefined ? nodeRef.nodeClass : null,
        parentNodeId: parentNodeId ? String(parentNodeId) : null,
        depth: Number.isFinite(depth) ? depth : 0,
        dataType: '',
        value: undefined
      };

      try {
        const ncNum = nodeClassToNumber(nodeRef.nodeClass);
        if (ncNum === NODECLASS_MAP.variable) {
          // read DataType attribute (returns NodeId)
          try {
            const dv = await session.read({ nodeId: nodeRef.nodeId, attributeId: AttributeIds.DataType });
            if (dv && dv.value && dv.value.value) {
              const dtStr = dv.value.value.toString ? dv.value.value.toString() : String(dv.value.value);
              node.dataType = nodeIdStringToBuiltinName(dtStr);
            }
          } catch (e) { /* ignore */ }
          // read Value if requested
          if (includeValue) {
            try {
              const val = await session.read({ nodeId: nodeRef.nodeId, attributeId: AttributeIds.Value });
              if (val && val.value) node.value = val.value.value;
            } catch (e) { /* ignore */ }
          }
        }
      } catch (e) { /* ignore */ }
      return node;
    }

    async function browseNode(nodeId, depth) {
      if (visited >= maxNodes) return;
      if (depth > maxDepth) return;
      const nodeKey = String(nodeId || '');
      if (traversedNodeIds.has(nodeKey)) return;
      traversedNodeIds.add(nodeKey);

      let browseResult;
      try {
        browseResult = await session.browse(nodeId);
      } catch (e) {
        return;
      }

      let refs = Array.isArray(browseResult.references) ? browseResult.references.slice() : [];

      try {
        while (browseResult && browseResult.continuationPoint) {
          const nextResults = await session.browseNext([browseResult.continuationPoint], false);
          if (!Array.isArray(nextResults) || !nextResults[0]) break;
          browseResult = nextResults[0];
          if (Array.isArray(browseResult.references) && browseResult.references.length) {
            refs = refs.concat(browseResult.references);
          } else {
            break;
          }
        }
      } catch (e) { /* ignore */ }

      // Deduplicate sibling references by target NodeId to avoid repeated children.
      const seenRefTargets = new Set();
      refs = sortReferencesStable(refs).filter((r) => {
        const targetId = r && r.nodeId ? String(r.nodeId) : '';
        if (!targetId) return true;
        if (seenRefTargets.has(targetId)) return false;
        seenRefTargets.add(targetId);
        return true;
      });

      for (const ref of refs) {
        if (visited >= maxNodes) break;

        const preliminaryNc = nodeClassToNumber(ref.nodeClass);

        // if only variable filter is requested and ref is not variable -> recurse only
        if (normalizedNodeClassFilter && normalizedNodeClassFilter.length === 1 && normalizedNodeClassFilter[0] === NODECLASS_MAP.variable) {
          if (preliminaryNc !== NODECLASS_MAP.variable) {
            await browseNode(ref.nodeId, depth + 1);
            continue;
          }
        }

        const node = await enrichNode(ref, nodeId, depth + 1);

        if (passesFilters(ref, node)) {
          const emittedKey = String(node.nodeId || '');
          if (emittedKey && emittedNodeIds.has(emittedKey)) {
            await browseNode(ref.nodeId, depth + 1);
            continue;
          }
          result.push(node);
          if (emittedKey) emittedNodeIds.add(emittedKey);
          visited++;
        }

        await browseNode(ref.nodeId, depth + 1);
      }
    }

    await browseNode(startNodeId, 0);

    await session.close();
    await client.disconnect();

    return res.json({ nodes: result.slice(0, maxNodes), count: result.length });
  } catch (err) {
    try { if (session) await session.close(); } catch (e) {}
    try { await client.disconnect(); } catch (e) {}
    return res.status(500).json({ error: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;