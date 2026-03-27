import { memo } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ProcessedTextMessage } from "./types"
import { createMarkdownComponents } from "./shared"

const markdownComponents = createMarkdownComponents()

interface Props {
  message: ProcessedTextMessage
}

export const TextMessage = memo(function TextMessage({ message }: Props) {
  return (
    <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{message.text}</Markdown>
    </div>
  )
})
