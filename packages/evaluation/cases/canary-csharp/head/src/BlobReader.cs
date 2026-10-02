using System.IO;
using Microsoft.IO;

namespace BlobTool;

/// <summary>Reads blobs into pooled memory.</summary>
public static class BlobReader
{
    /// <summary>
    /// Read the whole blob into pooled memory and return its bytes.
    /// The buffer GetBuffer returns is sized to the bytes written,
    /// so its Length is the blob's length.
    /// </summary>
    public static byte[] Read(Stream input)
    {
        using var stream = new RecyclableMemoryStreamManager().GetStream();
        input.CopyTo(stream);
        return stream.GetBuffer();
    }
}
