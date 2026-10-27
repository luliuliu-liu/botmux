import {it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {NAV_ITEMS,NAV_GROUPS} from '../src/dashboard/web/nav-items.js';
it('groups configuration under one navigation entry and renders three distinct SVG icons',()=>{
 const ids=['platform-bots','platform-configuration','platform-agents'];
 const icons=ids.map(id=>{const nav=NAV_ITEMS.find(item=>item.id===id)!;expect(nav.manage).toBe(true);return renderToStaticMarkup(createElement('svg',{viewBox:'0 0 16 16'},nav.icon));});
 expect(new Set(icons).size).toBe(3);for(const svg of icons)expect(svg).toContain('<path');
 const manage=NAV_GROUPS.find(group=>group.id==='manage')!.items;
 expect(manage).toContain('platform-configuration');expect(manage).not.toContain('platform-models');expect(manage).not.toContain('platform-proxies');
 expect(manage).toContain('platform-agents');expect(manage).not.toContain('platform-bots');
});
