#!/usr/bin/env python3
"""
Compression Benchmark Script
Tests popular compression formats for demo data:
- Compress speed
- Uncompress speed
- Compression ratio

Usage: python compression_benchmark.py [input_file]
"""

import time
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple
import json

# Try to import compression libraries
try:
    import zlib
    ZLIB_AVAILABLE = True
except ImportError:
    ZLIB_AVAILABLE = False

try:
    import gzip
    GZIP_AVAILABLE = True
except ImportError:
    GZIP_AVAILABLE = False

try:
    import lzma
    LZMA_AVAILABLE = True
except ImportError:
    LZMA_AVAILABLE = False

try:
    import bz2
    BZ2_AVAILABLE = True
except ImportError:
    BZ2_AVAILABLE = False

try:
    import brotli
    BROTLI_AVAILABLE = True
except ImportError:
    BROTLI_AVAILABLE = False

try:
    import zstandard as zstd
    ZSTD_AVAILABLE = True
except ImportError:
    ZSTD_AVAILABLE = False

try:
    import lz4.frame
    LZ4_AVAILABLE = True
except ImportError:
    LZ4_AVAILABLE = False


class CompressionBenchmark:
    def __init__(self, data: bytes):
        self.original_data = data
        self.original_size = len(data)
        self.results: List[Dict] = []
        
    def benchmark(self) -> Dict:
        """Run all compression benchmarks"""
        print(f"Original size: {self.format_size(self.original_size)}")
        print()
        
        # Test available compressors
        if ZLIB_AVAILABLE:
            self.test_zlib()
        
        if GZIP_AVAILABLE:
            self.test_gzip()
            
        if LZMA_AVAILABLE:
            self.test_lzma()
            
        if BZ2_AVAILABLE:
            self.test_bz2()
            
        if BROTLI_AVAILABLE:
            self.test_brotli()
            
        if ZSTD_AVAILABLE:
            self.test_zstd()
            
        if LZ4_AVAILABLE:
            self.test_lz4()
        
        # Print results
        self.print_results()
        
        # Find best options
        return self.find_best()
    
    def test_zlib(self):
        """Test zlib compression"""
        name = "zlib"
        
        # Test different compression levels
        for level in [1, 3, 6, 9]:
            try:
                # Compress
                start = time.perf_counter()
                compressed = zlib.compress(self.original_data, level)
                compress_time = time.perf_counter() - start
                
                # Decompress
                start = time.perf_counter()
                decompressed = zlib.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                # Record results
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def test_gzip(self):
        """Test gzip compression"""
        name = "gzip"
        
        for level in [1, 3, 6, 9]:
            try:
                # Compress
                start = time.perf_counter()
                compressed = gzip.compress(self.original_data, compresslevel=level)
                compress_time = time.perf_counter() - start
                
                # Decompress
                start = time.perf_counter()
                decompressed = gzip.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def test_lzma(self):
        """Test LZMA (xz) compression"""
        name = "lzma"
        
        for level in [0, 3, 6, 9]:
            try:
                # Compress
                start = time.perf_counter()
                compressed = lzma.compress(self.original_data, preset=level)
                compress_time = time.perf_counter() - start
                
                # Decompress
                start = time.perf_counter()
                decompressed = lzma.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def test_bz2(self):
        """Test bzip2 compression"""
        name = "bz2"
        
        for level in [1, 3, 6, 9]:
            try:
                # Compress
                start = time.perf_counter()
                compressed = bz2.compress(self.original_data, compresslevel=level)
                compress_time = time.perf_counter() - start
                
                # Decompress
                start = time.perf_counter()
                decompressed = bz2.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def test_brotli(self):
        """Test Brotli compression"""
        name = "brotli"
        
        for level in [0, 3, 6, 11]:
            try:
                # Compress
                start = time.perf_counter()
                compressed = brotli.compress(self.original_data, quality=level)
                compress_time = time.perf_counter() - start
                
                # Decompress
                start = time.perf_counter()
                decompressed = brotli.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def test_zstd(self):
        """Test Zstandard compression"""
        name = "zstd"
        
        for level in [1, 3, 6, 10, 19]:
            try:
                compressor = zstd.ZstdCompressor(level=level)
                
                # Compress
                start = time.perf_counter()
                compressed = compressor.compress(self.original_data)
                compress_time = time.perf_counter() - start
                
                # Decompress
                decompressor = zstd.ZstdDecompressor()
                start = time.perf_counter()
                decompressed = decompressor.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def test_lz4(self):
        """Test LZ4 compression"""
        name = "lz4"
        
        for level in [1, 6, 16]:
            try:
                # Compress
                start = time.perf_counter()
                compressed = lz4.frame.compress(self.original_data, compression_level=level)
                compress_time = time.perf_counter() - start
                
                # Decompress
                start = time.perf_counter()
                decompressed = lz4.frame.decompress(compressed)
                decompress_time = time.perf_counter() - start
                
                # Verify
                if decompressed != self.original_data:
                    continue
                
                self.results.append({
                    'name': f"{name}_level_{level}",
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'compressed_size': len(compressed),
                    'compression_ratio': len(compressed) / self.original_size,
                    'space_saving': 1 - (len(compressed) / self.original_size)
                })
                
            except Exception as e:
                pass
    
    def print_results(self):
        """Print benchmark results as table"""
        print()
        print("=" * 100)
        print("COMPRESSION BENCHMARK RESULTS")
        print("=" * 100)
        print()
        
        # Print table header
        print(f"{'Format':<20} {'Level':<6} {'Size':<12} {'Saved':<8} {'Comp(ms)':<10} {'Decomp(ms)':<12} {'Total(ms)':<10}")
        print("-" * 100)
        
        # Sort by format name first, then by level numerically
        def sort_key(result):
            name = result['name']
            if '_level_' in name:
                format_name, level = name.split('_level_', 1)
            else:
                format_name, level = name.rsplit('_', 1)
            return (format_name, int(level))
        
        sorted_results = sorted(self.results, key=sort_key)
        
        for result in sorted_results:
            # Remove "_level" suffix from format name
            name = result['name']
            if '_level_' in name:
                format_name, level = name.split('_level_', 1)
            else:
                format_name, level = name.rsplit('_', 1)
            
            total_time = result['compress_time'] + result['decompress_time']
            
            print(f"{format_name:<20} {level:<6} {self.format_size(result['compressed_size']):<12} "
                  f"{result['space_saving']*100:>6.1f}% {result['compress_time']*1000:>8.2f} "
                  f"{result['decompress_time']*1000:>10.2f} {total_time*1000:>8.2f}")
        
        print()
        print("=" * 100)
        print("RECOMMENDATIONS")
        print("=" * 100)
        print()
        
        # Find best options
        best_compression = min(self.results, key=lambda x: x['compressed_size'])
        fastest_compress = min(self.results, key=lambda x: x['compress_time'])
        fastest_decompress = min(self.results, key=lambda x: x['decompress_time'])
        best_balance = min(self.results, key=lambda x: x['compress_time'] + x['decompress_time'])
        
        print(f"Best compression ratio: {best_compression['name']} ({best_compression['space_saving']*100:.1f}% saved)")
        print(f"Fastest compression: {fastest_compress['name']} ({fastest_compress['compress_time']*1000:.2f}ms)")
        print(f"Fastest decompression: {fastest_decompress['name']} ({fastest_decompress['decompress_time']*1000:.2f}ms)")
        print(f"Best balance: {best_balance['name']} ({(best_balance['compress_time'] + best_balance['decompress_time'])*1000:.2f}ms total)")
    
    def find_best(self) -> Dict:
        """Find best options for different use cases"""
        return {
            'best_compression': min(self.results, key=lambda x: x['compressed_size']),
            'fastest_compress': min(self.results, key=lambda x: x['compress_time']),
            'fastest_decompress': min(self.results, key=lambda x: x['decompress_time']),
            'best_balance': min(self.results, key=lambda x: x['compress_time'] + x['decompress_time'])
        }
    
    @staticmethod
    def format_size(size: int) -> str:
        """Format size in human-readable format"""
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024:
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} TB"


def generate_test_data(size_mb: int = 10) -> bytes:
    """Generate test data that simulates demo data"""
    # Generate repetitive data (like demo frames)
    import random
    
    # Create a pattern that repeats (simulates similar frames)
    pattern = bytes([random.randint(0, 255) for _ in range(1024)])
    
    # Repeat pattern with some variations
    data = bytearray()
    for i in range(size_mb * 1024):
        # Add small variations to pattern
        variation = bytes([random.randint(0, 255) for _ in range(64)])
        data.extend(pattern[:-64] + variation)
    
    return bytes(data)


def find_demo_files(demos_dir: Path) -> List[Path]:
    """Find all demo files in directory"""
    return list(demos_dir.glob("*.demo"))

def find_biggest_and_median(files: List[Path]) -> Tuple[Path, Path]:
    """Find biggest and median files by size"""
    # Sort by size
    sorted_files = sorted(files, key=lambda f: f.stat().st_size)
    
    biggest = sorted_files[-1]
    median = sorted_files[len(sorted_files) // 2]
    
    return biggest, median

def main():
    demos_dir = Path("c:/TEMP/_WEB/FPSWebTest/server_bun/demos")
    
    if len(sys.argv) > 1:
        # Use provided file
        input_file = Path(sys.argv[1])
        if not input_file.exists():
            print(f"Error: File not found: {input_file}")
            sys.exit(1)
        
        print(f"File: {input_file.name} ({CompressionBenchmark.format_size(input_file.stat().st_size)})")
        print()
        
        with open(input_file, 'rb') as f:
            data = f.read()
        
        # Run single benchmark
        benchmark = CompressionBenchmark(data)
        benchmark.benchmark()
        
        # Save results
        script_dir = Path(__file__).parent
        output_file = script_dir / "compression_results.json"
        with open(output_file, 'w') as f:
            json.dump({
                'original_size': len(data),
                'results': benchmark.results
            }, f, indent=2)
        
        print()
        print(f"Results saved to: {output_file}")
        
    elif demos_dir.exists():
        # Auto-select biggest and median from demos directory
        demo_files = find_demo_files(demos_dir)
        
        if len(demo_files) < 2:
            print(f"Need at least 2 demo files, found {len(demo_files)}")
            sys.exit(1)
        
        biggest, median = find_biggest_and_median(demo_files)
        
        print(f"Biggest: {biggest.name} ({CompressionBenchmark.format_size(biggest.stat().st_size)})")
        print(f"Median: {median.name} ({CompressionBenchmark.format_size(median.stat().st_size)})")
        print()
        
        # Benchmark biggest file
        print("=" * 100)
        print(f"BENCHMARKING: {biggest.name}")
        print("=" * 100)
        with open(biggest, 'rb') as f:
            biggest_data = f.read()
        
        biggest_benchmark = CompressionBenchmark(biggest_data)
        biggest_benchmark.benchmark()
        
        print()
        print("=" * 100)
        print(f"BENCHMARKING: {median.name}")
        print("=" * 100)
        with open(median, 'rb') as f:
            median_data = f.read()
        
        median_benchmark = CompressionBenchmark(median_data)
        median_benchmark.benchmark()
        
        # Save combined results
        script_dir = Path(__file__).parent
        output_file = script_dir / "compression_results.json"
        with open(output_file, 'w') as f:
            json.dump({
                'biggest_file': str(biggest),
                'biggest_size': len(biggest_data),
                'biggest_results': biggest_benchmark.results,
                'median_file': str(median),
                'median_size': len(median_data),
                'median_results': median_benchmark.results
            }, f, indent=2)
        
        print()
        print(f"Results saved to: {output_file}")
        
    else:
        # Generate test data
        data = generate_test_data(10)
        
        print(f"Generated test data: {CompressionBenchmark.format_size(len(data))}")
        print()
        
        benchmark = CompressionBenchmark(data)
        benchmark.benchmark()
        
        # Save results
        script_dir = Path(__file__).parent
        output_file = script_dir / "compression_results.json"
        with open(output_file, 'w') as f:
            json.dump({
                'original_size': len(data),
                'results': benchmark.results
            }, f, indent=2)
        
        print()
        print(f"Results saved to: {output_file}")


if __name__ == "__main__":
    main()
