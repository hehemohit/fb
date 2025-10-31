import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = 'http://localhost:4000'

function Home() {
  const handleConnect = () => {
    window.location.href = `${API_BASE}/auth/facebook`
  }
  return (
    <div className="fb-shell">
      <div className="fb-card">
        <h1 className="fb-title">Connect to Facebook</h1>
        <p className="fb-sub">Authorize to manage your Page and publish posts.</p>
        <button className="fb-btn fb-btn-primary" onClick={handleConnect}>
          Continue with Facebook
        </button>
      </div>
    </div>
  )
}

function SelectPage() {
  const [pages, setPages] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('')
  const [pageName, setPageName] = useState('')

  useEffect(() => {
    const run = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/pages`, { credentials: 'include' })
        if (!res.ok) throw new Error('Unauthorized')
        const data = await res.json()
        setPages(data)
        if (data?.length) {
          setSelected(data[0].id)
          setPageName(data[0].name)
        }
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    run()
  }, [])

  const selectedPageToken = useMemo(() => {
    const p = pages.find(p => p.id === selected)
    return p?.access_token || ''
  }, [pages, selected])

  const savePage = async () => {
    if (!selected) return
    const body = {
      pageId: selected,
      pageName,
      pageAccessToken: selectedPageToken,
    }
    const res = await fetch(`${API_BASE}/api/pages/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (res.ok) {
      window.location.href = `/page-actions?pageId=${encodeURIComponent(selected)}`
    }
  }

  if (loading) return <div className="fb-shell"><div className="fb-card"><p>Loading pages…</p></div></div>
  if (error) return <div className="fb-shell"><div className="fb-card"><p className="fb-error">{error}</p></div></div>

  return (
    <div className="fb-shell">
      <div className="fb-card">
        <h1 className="fb-title">Select Page</h1>
        <div className="fb-field">
          <label className="fb-label">Page</label>
          <select className="fb-select" value={selected} onChange={(e) => {
            setSelected(e.target.value)
            const p = pages.find(pp => pp.id === e.target.value)
            setPageName(p?.name || '')
          }}>
            {pages.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <button className="fb-btn fb-btn-primary" onClick={savePage} disabled={!selectedPageToken}>Save Page</button>
      </div>
    </div>
  )
}

function Composer({ pageId }) {
  const [message, setMessage] = useState('')
  const [link, setLink] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [imageUrls, setImageUrls] = useState([])
  const [droppedFiles, setDroppedFiles] = useState([])
  const [dragging, setDragging] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('') // yyyy-MM-ddThh:mm
  const [publishNow, setPublishNow] = useState(true)
  const [result, setResult] = useState('')
  const [posts, setPosts] = useState([])

  const scheduledUnix = scheduledAt ? Math.floor(new Date(scheduledAt).getTime() / 1000) : undefined

  const postText = async () => {
    if (scheduledAt) {
      const s = Math.floor(new Date(scheduledAt).getTime() / 1000)
      const now = Math.floor(Date.now() / 1000)
      if (s < now + 600 || s > now + 75 * 24 * 3600) {
        alert('Schedule must be at least 10 minutes from now and within 75 days.')
        return
      }
    }
    const res = await fetch(`${API_BASE}/api/post/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, message, link, scheduledPublishTime: scheduledUnix, publishNow }),
    })
    const data = await res.json()
    setResult(JSON.stringify(data))
    fetchPosts()
  }

  const postPhoto = async () => {
    if (scheduledAt) {
      const s = Math.floor(new Date(scheduledAt).getTime() / 1000)
      const now = Math.floor(Date.now() / 1000)
      if (s < now + 600 || s > now + 75 * 24 * 3600) {
        alert('Schedule must be at least 10 minutes from now and within 75 days.')
        return
      }
    }
    const res = await fetch(`${API_BASE}/api/post/photo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, message, imageUrl, scheduledPublishTime: scheduledUnix, publishNow }),
    })
    const data = await res.json()
    setResult(JSON.stringify(data))
    fetchPosts()
  }

  const addImageUrl = () => {
    if (!imageUrl) return
    setImageUrls((arr) => [...arr, imageUrl])
    setImageUrl('')
  }

  const postMulti = async () => {
    if (!imageUrls.length) return
    const res = await fetch(`${API_BASE}/api/post/photos-multi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, message, imageUrls }),
    })
    const data = await res.json()
    setResult(JSON.stringify(data))
    setImageUrls([])
    fetchPosts()
  }

  const postUploadedFiles = async () => {
    if (!droppedFiles.length) return
    // Upload sequentially to keep API simple
    const results = []
    for (const file of droppedFiles) {
      const form = new FormData()
      form.append('file', file)
      form.append('pageId', pageId)
      form.append('message', message)
      if (scheduledUnix) form.append('scheduledPublishTime', String(scheduledUnix))
      form.append('publishNow', String(publishNow))
      const res = await fetch(`${API_BASE}/api/post/photo-upload`, { method: 'POST', body: form })
      results.push(await res.json())
    }
    setResult(JSON.stringify(results))
    setDroppedFiles([])
    fetchPosts()
  }

  const postCombined = async () => {
    const form = new FormData()
    form.append('pageId', pageId)
    form.append('message', message)
    if (imageUrls.length) form.append('imageUrls', JSON.stringify(imageUrls))
    droppedFiles.forEach((f) => form.append('files', f))
    const res = await fetch(`${API_BASE}/api/post/compose`, { method: 'POST', body: form })
    const data = await res.json()
    setResult(JSON.stringify(data))
    setDroppedFiles([])
    setImageUrls([])
    fetchPosts()
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const dt = e.dataTransfer
    if (dt?.files && dt.files.length) {
      const imgs = Array.from(dt.files).filter((f) => f.type.startsWith('image/'))
      if (imgs.length) setDroppedFiles((prev) => [...prev, ...imgs])
    }
    const text = dt.getData('text')
    if (text && /^https?:\/\//.test(text)) setImageUrl(text)
  }

  const onDragOver = (e) => { e.preventDefault(); setDragging(true) }
  const onDragLeave = () => setDragging(false)

  const fetchPosts = async () => {
    const res = await fetch(`${API_BASE}/api/posts?pageId=${pageId}&limit=5`)
    const data = await res.json()
    setPosts(data.data || [])
  }

  useEffect(() => { fetchPosts() }, [])

  const editPost = async (postId, newMessage) => {
    await fetch(`${API_BASE}/api/post/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, postId, message: newMessage }),
    })
    fetchPosts()
  }

  const deletePost = async (postId) => {
    await fetch(`${API_BASE}/api/post?postId=${postId}&pageId=${pageId}`, { method: 'DELETE' })
    fetchPosts()
  }

  const toggleHide = async (postId, isHidden) => {
    await fetch(`${API_BASE}/api/post/hide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, postId, isHidden: !isHidden }),
    })
    fetchPosts()
  }

  return (
    <div className="fb-composer">
      <h2 className="fb-section-title">Create Post</h2>
      <div className="fb-field">
        <label className="fb-label">Message</label>
        <textarea
          className="fb-textarea"
          placeholder="Write something..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
        />
      </div>
      <div className="fb-field">
        <label className="fb-label">Link (optional)</label>
        <input className="fb-input" placeholder="https://example.com" value={link} onChange={(e) => setLink(e.target.value)} />
      </div>
      <div className="fb-row">
        <div className="fb-field" style={{ flex: 1 }}>
          <label className="fb-label">Schedule (optional)</label>
          <input className="fb-input" type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        </div>
        <div className="fb-field" style={{ width: 180 }}>
          <label className="fb-label">Publish now</label>
          <select className="fb-select" value={publishNow ? 'yes' : 'no'} onChange={(e) => setPublishNow(e.target.value === 'yes')}>
            <option value="yes">Yes</option>
            <option value="no">No (create unpublished)</option>
          </select>
        </div>
      </div>
      <div className="fb-row">
        <button className="fb-btn" onClick={postText} disabled={!message}>Post Text</button>
        <input
          className="fb-input"
          placeholder="Image URL (optional)"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
        />
        <button className="fb-btn" onClick={postPhoto} disabled={!imageUrl}>Post Photo</button>
        <button className="fb-btn" onClick={addImageUrl} disabled={!imageUrl}>Add to Gallery</button>
      </div>
      <div
        className={`fb-dropzone ${dragging ? 'drag' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        Drag and drop image files here to upload directly
      </div>
      {droppedFiles.length > 0 && (
        <div className="fb-result">
          <div className="fb-row" style={{ justifyContent: 'space-between' }}>
            <div>Files ready: {droppedFiles.length}</div>
          </div>
          <ul>
            {droppedFiles.map((f, i) => (<li key={i}>{f.name}</li>))}
          </ul>
        </div>
      )}
      {imageUrls.length > 0 && (
        <div className="fb-result">
          <div className="fb-row" style={{ justifyContent: 'space-between' }}>
            <div>Gallery images: {imageUrls.length}</div>
            <button className="fb-btn" onClick={postMulti}>Post Multi-photo</button>
          </div>
          <ul>
            {imageUrls.map((u, i) => (<li key={i}>{u}</li>))}
          </ul>
        </div>
      )}
      <div className="fb-row" style={{ justifyContent: 'flex-end' }}>
        <button
          className="fb-btn fb-btn-primary"
          onClick={async () => {
            if (droppedFiles.length || imageUrls.length) {
              // Use combined compose
              const form = new FormData()
              form.append('pageId', pageId)
              form.append('message', message)
              if (link) form.append('link', link)
              if (imageUrls.length) form.append('imageUrls', JSON.stringify(imageUrls))
              if (scheduledUnix) form.append('scheduledPublishTime', String(scheduledUnix))
              form.append('publishNow', String(publishNow))
              droppedFiles.forEach((f) => form.append('files', f))
              const res = await fetch(`${API_BASE}/api/post/compose`, { method: 'POST', body: form })
              const data = await res.json()
              setResult(JSON.stringify(data))
              setDroppedFiles([])
              setImageUrls([])
              fetchPosts()
            } else {
              // Text/link only
              postText()
            }
          }}
          disabled={!message && !imageUrls.length && !droppedFiles.length && !link}
        >
          Post
        </button>
      </div>
      {result && (
        <pre className="fb-result">{result}</pre>
      )}

      <h2 className="fb-section-title">Recent Posts</h2>
      {posts.map((p) => (
        <div key={p.id} className="fb-result">
          <div className="fb-field">
            <label className="fb-label">Post ID</label>
            <div>{p.id}</div>
          </div>
          <div className="fb-field">
            <label className="fb-label">Message</label>
            <textarea className="fb-textarea" defaultValue={p.message || ''} onBlur={(e) => editPost(p.id, e.target.value)} />
          </div>
          <div className="fb-row">
            <a className="fb-btn" href={p.permalink_url} target="_blank" rel="noreferrer">Open</a>
            <button className="fb-btn" onClick={() => toggleHide(p.id, p.is_hidden)}>{p.is_hidden ? 'Unhide' : 'Hide'}</button>
            <button className="fb-btn" onClick={() => deletePost(p.id)}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function CreatePost() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const pageId = params.get('pageId') || ''
  if (!pageId) {
    return (
      <div className="fb-shell">
        <div className="fb-card">
          <p className="fb-error">Missing pageId. Please select a page first.</p>
          <a className="fb-btn fb-btn-primary" href="/select-page">Go to Select Page</a>
        </div>
      </div>
    )
  }
  return (
    <div className="fb-shell">
      <div className="fb-card">
        <h1 className="fb-title">Create Post</h1>
        <Composer pageId={pageId} />
      </div>
    </div>
  )
}

function PageActions() {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const pageId = params.get('pageId') || ''
  if (!pageId) {
    return (
      <div className="fb-shell">
        <div className="fb-card">
          <p className="fb-error">Missing pageId. Please select a page first.</p>
          <a className="fb-btn fb-btn-primary" href="/select-page">Go to Select Page</a>
        </div>
      </div>
    )
  }
  return (
    <div className="fb-shell">
      <div className="fb-card">
        <h1 className="fb-title">Page Actions</h1>
        <div className="fb-row" style={{ gap: 12 }}>
          <a className="fb-btn fb-btn-primary" href={`/create-post?pageId=${encodeURIComponent(pageId)}`}>Create Post</a>
          <a className="fb-btn" href={`/insights?pageId=${encodeURIComponent(pageId)}`}>Insights</a>
        </div>
      </div>
    </div>
  )
}

function Insights() {
  const API_BASE = 'http://localhost:4000'
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams()
  const initialPageId = urlParams.get('pageId') || ''
  const [pageId, setPageId] = useState(initialPageId)
  const [metrics, setMetrics] = useState('page_impressions,page_impressions_unique,page_engaged_users,page_content_activity,page_views_total')
  const [period, setPeriod] = useState('day')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [pageInsights, setPageInsights] = useState([])
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [raw, setRaw] = useState(null)

  const fetchPageInsights = async () => {
    setLoading(true); setError('')
    try {
      const qs = new URLSearchParams({ pageId })
      if (metrics) qs.set('metrics', metrics)
      if (period) qs.set('period', period)
      if (since) qs.set('since', since)
      if (until) qs.set('until', until)
      const r1 = await fetch(`${API_BASE}/api/insights/page?${qs.toString()}`)
      const d1 = await r1.json()
      setPageInsights(d1.data || [])
      const r2 = await fetch(`${API_BASE}/api/insights/posts?pageId=${encodeURIComponent(pageId)}&limit=10&metrics=post_impressions,post_impressions_unique,post_engaged_users,post_clicks,post_reactions_by_type_total`)
      const d2 = await r2.json()
      setPosts(d2.data || [])
      setRaw({ page: d1, posts: d2 })
    } catch (e) {
      setError(String(e.message || e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fb-shell">
      <div className="fb-card">
        <h1 className="fb-title">Insights</h1>
        <div className="fb-row">
          <input className="fb-input" placeholder="Page ID" value={pageId} onChange={(e) => setPageId(e.target.value)} />
          <input className="fb-input" placeholder="Metrics (comma-separated)" value={metrics} onChange={(e) => setMetrics(e.target.value)} />
          <select className="fb-select" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="days_28">days_28</option>
            <option value="lifetime">lifetime</option>
          </select>
          <input className="fb-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          <input className="fb-input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          <button className="fb-btn fb-btn-primary" onClick={fetchPageInsights} disabled={!pageId}>Load</button>
        </div>

        {loading && <p>Loading…</p>}
        {error && <p className="fb-error">{error}</p>}

        {pageInsights.length > 0 && (
          <div className="fb-result">
            {pageInsights.map((m) => (
              <div key={m.name} style={{ marginBottom: 8 }}>
                <strong>{m.title || m.name}</strong>
                <div style={{ fontSize: 12, color: '#666' }}>{m.description}</div>
                <div style={{ marginTop: 4 }}>
                  {m.values?.slice(-7).map((v, i) => (
                    <span key={i} style={{ marginRight: 8 }}>{typeof v.value === 'object' ? JSON.stringify(v.value) : v.value}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {posts.length > 0 && (
          <div className="fb-result">
            <h3 className="fb-section-title">Recent Posts</h3>
            {posts.map((p) => {
              const toVal = (arr, name) => (arr.find(x => x.name === name)?.values?.[0]?.value)
              const reactions = toVal(p.insights, 'post_reactions_by_type_total') || 0
              const impressions = toVal(p.insights, 'post_impressions') || 0
              const uniqueImpr = toVal(p.insights, 'post_impressions_unique') || 0
              const engaged = toVal(p.insights, 'post_engaged_users') || 0
              const clicks = toVal(p.insights, 'post_clicks') || 0
              const reactionsTotal = typeof reactions === 'object' ? Object.values(reactions).reduce((a, b) => a + b, 0) : reactions
              return (
                <div key={p.id} className="fb-result">
                  <div><strong>{(p.message || '').slice(0, 80) || '(no message)'}</strong></div>
                  <div style={{ fontSize: 12 }}>
                    {new Date(p.created_time).toLocaleString()} · <a href={p.permalink_url} target="_blank" rel="noreferrer">Open</a>
                  </div>
                  <div style={{ marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                    <span>Impr: {impressions}</span>
                    <span>Unique: {uniqueImpr}</span>
                    <span>Engaged: {engaged}</span>
                    <span>Clicks: {clicks}</span>
                    <span>Reactions: {reactionsTotal}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {raw && (
          <div className="fb-result">
            <details>
              <summary>Raw response</summary>
              <pre className="fb-result" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(raw, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}

function App() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path === '/select-page') return <SelectPage />
  if (path === '/insights') return <Insights />
  if (path === '/create-post') return <CreatePost />
  if (path === '/page-actions') return <PageActions />
  return <Home />
}

export default App
