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
  const [saved, setSaved] = useState(false)
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
    if (res.ok) setSaved(true)
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
        {saved && <Composer pageId={selected} />}
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
        <button className="fb-btn fb-btn-primary" onClick={postUploadedFiles} disabled={!droppedFiles.length}>Upload & Post</button>
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

function App() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path === '/select-page') return <SelectPage />
  return <Home />
}

export default App
