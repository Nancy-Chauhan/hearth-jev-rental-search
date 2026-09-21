(() => {
  if (!document.body) return null;
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    const scope=e.form||e.parentElement;
    const submitField=e.matches('button[type="submit"],input[type="submit"]') &&
      scope?.querySelector('input[placeholder],input[aria-label],[role="searchbox"]');
    const submitHint=submitField &&
      (submitField.getAttribute('aria-label')||submitField.getAttribute('placeholder'));
    const nearby=(e.parentElement?.innerText||'').replace(/\s+/g,' ').trim().slice(0,160);
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') ||
      (submitHint ? 'Submit '+submitHint : '') || (nearby ? 'Control near '+nearby : '');
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height}};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], fallbackWords=[];
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0,fallbackLength=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template')) continue;
    // Same text nodes, without the visibility test, in case the page will not report one.
    if (fallbackLength<6000) { fallbackWords.push(value); fallbackLength+=value.length; }
    if (!visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  // A content-visibility SPA in an unrendered tab can report every node invisible, which would
  // hand the model an empty page. Fall back to the same text nodes without that test.
  const modelText=text.length>=40 ? text : fallbackWords.join('\n').slice(0,6000);
  const listingByHref=new Map();
  // Detail-page path shapes across marketplaces, including Craigslist's /view/d/<slug>/<token>.
  const listingPath=/(\/marketplace\/item\/|\/homedetails\/|\/home\/|\/view\/d\/|\/d\/[^/]+\/(?:\d+\.html|[A-Za-z0-9]{8,})\/?$|\/apartments?\/|\/property\/|\/listing\/|\/for-rent\/)/i;
  const cardSelector='article,li,[role="article"],[class*="search-result"],[class*="listing-card"],'+
    '[class*="result-card"]';
  const looseCardSelector='[data-test*="property-card"],[class*="property-card"]';
  const priceSelector='[class*="price" i],[data-test*="price" i],[id*="price" i]';
  // Comma groups must be exactly three digits, so a card whose price runs into the next
  // word ("$3,6501 Bed 1 Bath") yields $3,650 instead of $3,6501.
  const pricePattern=/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?:\s*(?:\+|[-–])\s*\$?\d{1,3}(?:,\d{3})*)?(?:\s*\/\s*mo)?/i;
  // Amenity keywords only; a listing is never credited with one it does not mention.
  const amenityWords=['parking','garage','laundry','washer','dryer','dishwasher','gym','fitness',
    'pool','pets','furnished','balcony','patio','air conditioning','elevator','doorman','storage',
    'hardwood','fireplace','utilities included','no fee'];
  for (const link of document.querySelectorAll('a[href]')) {
    let url;
    try { url=new URL(link.href,location.href); } catch { continue; }
    if (!listingPath.test(url.pathname)) continue;
    // Several anchors in one card differ only by fragment; treat them as the same listing.
    url.hash='';
    const href=url.href;
    const card=link.closest(cardSelector) || link.closest(looseCardSelector) || link.parentElement;
    const summary=(card?.innerText||link.innerText||'').replace(/(?:\s*[•·]\s*)+/g,' ').replace(/\s+/g,' ').trim();
    const cardTitle=(
      card?.querySelector('address')?.innerText ||
      card?.querySelector('h1,h2,h3,h4')?.innerText ||
      card?.querySelector('[class*="title"]:not(a)')?.innerText || '')
      .replace(/\s+/g,' ').trim().slice(0,180);
    const anchorTitle=cardTitle ||
      (link.getAttribute('aria-label')||link.getAttribute('title')||link.innerText||'')
        .replace(/\s+/g,' ').trim().slice(0,180);
    // A dedicated price element is authoritative; card text can start with a discounted amount.
    const price=(card?.querySelector(priceSelector)?.innerText||'').match(pricePattern)?.[0]||
      summary.match(pricePattern)?.[0]||'';
    if (!price || (!anchorTitle && summary.length<12)) continue;
    const photo=card?.querySelector('img');
    const shot=photo?.currentSrc||photo?.src||'';
    // Lazy loaders hold a 1x1 data-URI pixel until the card scrolls into view; treat it as no photo.
    const image=shot && !shot.startsWith('data:') && !(photo.complete && photo.naturalWidth<=2) ? shot : '';
    const beds=summary.match(/(?:studio|\b\d{1,2}\s*(?:bd|bed|br)s?\b)/i)?.[0]||'';
    const baths=summary.match(/\b\d{1,2}(?:\.\d+)?\s*(?:ba|bath)s?\b/i)?.[0]||'';
    const sqft=summary.match(/[\d,]+\s*(?:ft²|ft2|sq\.?\s*ft\.?s?|sqft)/i)?.[0]||'';
    const address=card?.querySelector('address')?.innerText?.trim()||'';
    const time=card?.querySelector('time');
    const posted_at=time?.getAttribute('datetime')||'';
    const posted_text=time?.innerText?.trim()||'';
    const entry={href,title:anchorTitle||summary.slice(0,180),price,beds,baths,sqft,address,posted_at,posted_text,
      image,summary:summary.slice(0,700),fromLink:Boolean(anchorTitle)};
    const existing=listingByHref.get(href);
    if (!existing) listingByHref.set(href,entry);
    else {
      // One card often exposes both an image-only anchor and a titled one; keep the titled record.
      const better=entry.fromLink!==existing.fromLink ? entry.fromLink :
        entry.title.length>existing.title.length;
      const merged=better?entry:existing, other=better?existing:entry;
      for (const key of ['image','beds','baths','sqft']) if (!merged[key]) merged[key]=other[key]||'';
      listingByHref.set(href,merged);
    }
    if (listingByHref.size>=24) break;
  }
  const listings=[...listingByHref.values()].map(({fromLink,...rest})=>rest);
  // Being on a listing's own page is already paid for: capture the facts the card could not show.
  let detail=null;
  if (listingPath.test(location.pathname)) {
    const priceText=(document.querySelector(priceSelector)?.innerText||'');
    const heading=document.querySelector('h1')?.innerText||'';
    // The model-facing text is capped; the heading and title are the densest listing facts.
    const scan=`${heading}\n${document.title}\n${priceText}\n${modelText}`;
    const priceMatch=scan.match(pricePattern)||document.body.innerText.match(pricePattern);
    const address=(document.querySelector('address')?.innerText||'').replace(/\s+/g,' ').trim().slice(0,160);
    // The tightest block holding a substantial amount of prose; skip page chrome entirely.
    const blocks=[...document.querySelectorAll('article,section,div,p,li,td')]
      .filter(e=>!e.closest('nav,header,footer,aside,form,script,style'))
      .map(e=>({e,prose:(e.innerText||'').trim()}))
      .filter(item=>item.prose.length>=200)
      .sort((a,b)=>(a.e.querySelectorAll('*').length-b.e.querySelectorAll('*').length)
        || (b.prose.length-a.prose.length));
    const description=(blocks[0]?.prose||'').replace(/\s+/g,' ').trim().slice(0,1200);
    // Only a real date or relative age counts; "available" in prose is not a posting date.
    const posted=(scan.match(/(?:posted|listed)\s*(?:on\s+)?((?:[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,?\s*\d{4})?)|(?:\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|(?:\d+\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?)\s+ago))/i)||['',''])[1];
    detail={
      title:(heading||document.title||'').replace(/\s+/g,' ').trim().slice(0,180),
      price:priceMatch?priceMatch[0]:'',
      address,
      beds:scan.match(/(?:studio|\d+(?:\.\d+)?\s*(?:bd|bed|br)s?\b)/i)?.[0]||'',
      baths:scan.match(/\d+(?:\.\d+)?\s*(?:ba|bath)s?\b/i)?.[0]||'',
      sqft:scan.match(/[\d,]+\s*(?:ft²|ft2|sq\.?\s*ft\.?s?|sqft)/i)?.[0]||'',
      posted,
      description,
      amenities:amenityWords.filter(word=>new RegExp('\\b'+word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),
        'i').test(scan)).slice(0,8),
    };
    if (!detail.price && !detail.beds && !detail.description) detail=null;
  }
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,modelText,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text:modelText,listings,detail,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions};
})()
