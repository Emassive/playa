import dynamic from 'next/dynamic'

const MobileSynth = dynamic(
  () => import('@/components/MobileSynth').then(m => ({ default: m.MobileSynth })),
  {
    ssr: false,
    loading: () => (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-600 text-sm">Loading synth…</div>
      </div>
    ),
  }
)

export default function Home() {
  return <MobileSynth />
}
