import React, { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { Cpu, HardDrive, Zap, Activity, AlertCircle, CheckCircle } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { Alert } from '../design';

export interface ResourceDataPoint {
  timestamp: Date;
  timeLabel: string;
  cpu: number;
  ram: number;
  gpu: number;
}

export const ResourceMonitor: React.FC = () => {
  const { t } = useLanguage();
  const { isHighContrast } = useTheme();

  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [data, setData] = useState<ResourceDataPoint[]>(() => {
    const initial: ResourceDataPoint[] = [];
    const now = Date.now();
    for (let i = 20; i >= 0; i--) {
      const d = new Date(now - i * 2000);
      initial.push({
        timestamp: d,
        timeLabel: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        cpu: Math.floor(35 + Math.random() * 25),
        ram: Math.floor(40 + Math.random() * 15),
        gpu: Math.floor(50 + Math.random() * 30),
      });
    }
    return initial;
  });

  const [visibleMetrics, setVisibleMetrics] = useState({
    cpu: true,
    ram: true,
    gpu: true,
  });

  const latest = data[data.length - 1] || { cpu: 42, ram: 45, gpu: 65 };

  // Stream simulation every 2 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      const d = new Date();
      setData((prev) => {
        const last = prev[prev.length - 1];
        // Add natural random walk
        const nextCpu = Math.min(95, Math.max(15, last.cpu + (Math.random() * 12 - 6)));
        const nextRam = Math.min(90, Math.max(25, last.ram + (Math.random() * 6 - 3)));
        const nextGpu = Math.min(98, Math.max(20, last.gpu + (Math.random() * 16 - 8)));

        const newPoint: ResourceDataPoint = {
          timestamp: d,
          timeLabel: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          cpu: Math.round(nextCpu * 10) / 10,
          ram: Math.round(nextRam * 10) / 10,
          gpu: Math.round(nextGpu * 10) / 10,
        };
        return [...prev.slice(1), newPoint];
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  // Render D3 Line Chart
  useEffect(() => {
    if (!svgRef.current || !containerRef.current || data.length === 0) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const width = containerRef.current.clientWidth || 600;
    const height = 180;
    const margin = { top: 15, right: 20, bottom: 25, left: 35 };

    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const g = svg
      .attr('width', width)
      .attr('height', height)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Scales
    const timeDomain: [Date, Date] = [
      data[0]?.timestamp || new Date(),
      data[data.length - 1]?.timestamp || new Date(),
    ];

    const xScale = d3
      .scaleTime()
      .domain(timeDomain)
      .range([0, innerWidth]);

    const yScale = d3.scaleLinear().domain([0, 100]).range([innerHeight, 0]);

    // Gridlines
    const yGrid = d3.axisLeft(yScale).ticks(4).tickSize(-innerWidth).tickFormat(() => '');

    g.append('g')
      .attr('class', 'grid')
      .call(yGrid)
      .selectAll('line')
      .attr('stroke', isHighContrast ? '#333333' : '#27272a')
      .attr('stroke-dasharray', '3,3');

    // Axes
    const xAxis = d3
      .axisBottom(xScale)
      .ticks(5)
      .tickFormat((d) => d3.timeFormat('%H:%M:%S')(d as Date));

    const yAxis = d3
      .axisLeft(yScale)
      .ticks(4)
      .tickFormat((d) => `${d}%`);

    g.append('g')
      .attr('transform', `translate(0,${innerHeight})`)
      .call(xAxis)
      .attr('color', isHighContrast ? '#ffffff' : '#71717a')
      .selectAll('text')
      .style('font-size', '9px')
      .style('font-family', 'monospace');

    g.append('g')
      .call(yAxis)
      .attr('color', isHighContrast ? '#ffffff' : '#71717a')
      .selectAll('text')
      .style('font-size', '9px')
      .style('font-family', 'monospace');

    // Color Map
    const colors = {
      cpu: isHighContrast ? '#00ffff' : '#06b6d4', // Cyan
      ram: isHighContrast ? '#ffff00' : '#a855f7', // Purple/Yellow High-contrast
      gpu: isHighContrast ? '#ff00ff' : '#f43f5e', // Rose/Magenta
    };

    // Draw Lines
    const metrics: ('cpu' | 'ram' | 'gpu')[] = ['cpu', 'ram', 'gpu'];

    metrics.forEach((metric) => {
      if (!visibleMetrics[metric]) return;

      const lineGenerator = d3
        .line<ResourceDataPoint>()
        .x((d) => xScale(d.timestamp))
        .y((d) => yScale(d[metric]))
        .curve(d3.curveMonotoneX);

      // Area fill under CPU line if single metric or main
      if (metric === 'cpu' && !isHighContrast) {
        const areaGenerator = d3
          .area<ResourceDataPoint>()
          .x((d) => xScale(d.timestamp))
          .y0(innerHeight)
          .y1((d) => yScale(d.cpu))
          .curve(d3.curveMonotoneX);

        const gradientId = `cpu-gradient-${Math.random()}`;
        const gradient = svg
          .append('defs')
          .append('linearGradient')
          .attr('id', gradientId)
          .attr('x1', '0%')
          .attr('y1', '0%')
          .attr('x2', '0%')
          .attr('y2', '100%');

        gradient.append('stop').attr('offset', '0%').attr('stop-color', '#06b6d4').attr('stop-opacity', 0.25);
        gradient.append('stop').attr('offset', '100%').attr('stop-color', '#06b6d4').attr('stop-opacity', 0);

        g.append('path')
          .datum(data)
          .attr('fill', `url(#${gradientId})`)
          .attr('d', areaGenerator);
      }

      // Draw Path
      g.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', colors[metric])
        .attr('stroke-width', isHighContrast ? 2.5 : 2)
        .attr('d', lineGenerator);

      // Draw last data point marker
      const lastPoint = data[data.length - 1];
      if (lastPoint) {
        g.append('circle')
          .attr('cx', xScale(lastPoint.timestamp))
          .attr('cy', yScale(lastPoint[metric]))
          .attr('r', 4)
          .attr('fill', colors[metric])
          .attr('stroke', isHighContrast ? '#ffffff' : '#09090b')
          .attr('stroke-width', 1.5);
      }
    });
  }, [data, visibleMetrics, isHighContrast]);

  const getStatusBadge = (value: number) => {
    if (value > 85) {
      return (
        <span className={`text-[10px] px-2 py-0.5 rounded font-bold flex items-center space-x-1 ${
          isHighContrast ? 'bg-red-900 text-white border border-red-400' : 'bg-red-950/80 text-red-400 border border-red-500/40'
        }`}>
          <AlertCircle className="w-3 h-3" />
          <span>{t('heavyLoad')}</span>
        </span>
      );
    }
    return (
      <span className={`text-[10px] px-2 py-0.5 rounded font-bold flex items-center space-x-1 ${
        isHighContrast ? 'bg-white text-black font-extrabold border border-white' : 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/40'
      }`}>
        <CheckCircle className="w-3 h-3" />
        <span>{t('optimal')}</span>
      </span>
    );
  };

  return (
    <div
      className={`p-4 rounded-xl border backdrop-blur-md transition-all ${
        isHighContrast
          ? 'bg-black border-2 border-white text-white shadow-none'
          : 'bg-zinc-900/90 border-zinc-800 text-zinc-100 shadow-xl'
      }`}
    >
      {/*
        This panel has never read a host metric. The series is a seeded random
        walk generated in the browser. It was previously labelled "D3 LIVE" with
        invented hardware specifications beside it, which is the same class of
        defect the Revenue Boardroom's disclosure was added to fix.
      */}
      <div className="mb-4">
        <Alert role="warning" title="Illustrative load profile." live="none">
          This panel does not read host metrics — the series is generated in the browser. Wiring it to real
          telemetry is outstanding.
        </Alert>
      </div>

      {/* Widget Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div className="flex items-center space-x-2.5">
          <div className={`p-2 rounded-lg border ${
            isHighContrast ? 'bg-white text-black border-white' : 'bg-cyan-950 border-cyan-500/40 text-cyan-400'
          }`}>
            <Activity className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-sm font-bold tracking-tight">{t('resourceMonitorTitle')}</h3>
              <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-bold ${
                isHighContrast ? 'bg-yellow-400 text-black border border-white' : 'bg-zinc-950 text-cyan-400 border border-cyan-500/30'
              }`}>
                SAMPLE
              </span>
            </div>
            <p className="text-[11px] text-zinc-400 font-sans">{t('resourceMonitorDesc')}</p>
          </div>
        </div>

        {/* Metric Visibility Toggles */}
        <div className="flex items-center space-x-1.5 font-mono text-[11px]">
          <button
            onClick={() => setVisibleMetrics((p) => ({ ...p, cpu: !p.cpu }))}
            className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
              visibleMetrics.cpu
                ? isHighContrast
                  ? 'bg-cyan-400 text-black font-bold border-white'
                  : 'bg-cyan-950/80 text-cyan-300 border-cyan-500/50'
                : 'bg-transparent text-zinc-500 border-zinc-800 opacity-50'
            }`}
          >
            CPU
          </button>
          <button
            onClick={() => setVisibleMetrics((p) => ({ ...p, ram: !p.ram }))}
            className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
              visibleMetrics.ram
                ? isHighContrast
                  ? 'bg-yellow-400 text-black font-bold border-white'
                  : 'bg-purple-950/80 text-purple-300 border-purple-500/50'
                : 'bg-transparent text-zinc-500 border-zinc-800 opacity-50'
            }`}
          >
            RAM
          </button>
          <button
            onClick={() => setVisibleMetrics((p) => ({ ...p, gpu: !p.gpu }))}
            className={`px-2.5 py-1 rounded-lg border transition-all cursor-pointer ${
              visibleMetrics.gpu
                ? isHighContrast
                  ? 'bg-pink-500 text-white font-bold border-white'
                  : 'bg-rose-950/80 text-rose-300 border-rose-500/50'
                : 'bg-transparent text-zinc-500 border-zinc-800 opacity-50'
            }`}
          >
            GPU
          </button>
        </div>
      </div>

      {/* Numerical Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 font-mono">
        {/* CPU Card */}
        <div className={`p-3 rounded-lg border ${
          isHighContrast ? 'bg-black border-2 border-cyan-400' : 'bg-zinc-950 border-zinc-800'
        }`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-zinc-400 flex items-center space-x-1">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              <span>{t('cpuUsage')}</span>
            </span>
            {getStatusBadge(latest.cpu)}
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-xl font-bold text-cyan-400">{latest.cpu}%</span>
            <span className="text-[10px] text-zinc-500">modelled</span>
          </div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${isHighContrast ? 'bg-cyan-400' : 'bg-cyan-500'}`}
              style={{ width: `${latest.cpu}%` }}
            />
          </div>
        </div>

        {/* RAM Card */}
        <div className={`p-3 rounded-lg border ${
          isHighContrast ? 'bg-black border-2 border-yellow-400' : 'bg-zinc-950 border-zinc-800'
        }`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-zinc-400 flex items-center space-x-1">
              <HardDrive className={`w-3.5 h-3.5 ${isHighContrast ? 'text-yellow-400' : 'text-purple-400'}`} />
              <span>{t('ramUsage')}</span>
            </span>
            {getStatusBadge(latest.ram)}
          </div>
          <div className="flex items-baseline justify-between">
            <span className={`text-xl font-bold ${isHighContrast ? 'text-yellow-400' : 'text-purple-400'}`}>
              {latest.ram}%
            </span>
            <span className="text-[10px] text-zinc-500">modelled</span>
          </div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${isHighContrast ? 'bg-yellow-400' : 'bg-purple-500'}`}
              style={{ width: `${latest.ram}%` }}
            />
          </div>
        </div>

        {/* GPU Card */}
        <div className={`p-3 rounded-lg border ${
          isHighContrast ? 'bg-black border-2 border-pink-500' : 'bg-zinc-950 border-zinc-800'
        }`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] text-zinc-400 flex items-center space-x-1">
              <Zap className={`w-3.5 h-3.5 ${isHighContrast ? 'text-pink-400' : 'text-rose-400'}`} />
              <span>{t('gpuUsage')}</span>
            </span>
            {getStatusBadge(latest.gpu)}
          </div>
          <div className="flex items-baseline justify-between">
            <span className={`text-xl font-bold ${isHighContrast ? 'text-pink-400' : 'text-rose-400'}`}>
              {latest.gpu}%
            </span>
            <span className="text-[10px] text-zinc-500">modelled</span>
          </div>
          <div className="w-full bg-zinc-800 h-1.5 rounded-full mt-2 overflow-hidden">
            <div
              className={`h-full transition-all duration-500 ${isHighContrast ? 'bg-pink-500' : 'bg-rose-500'}`}
              style={{ width: `${latest.gpu}%` }}
            />
          </div>
        </div>
      </div>

      {/* D3 Live Line Chart Container */}
      <div ref={containerRef} className="w-full overflow-hidden bg-zinc-950 p-2 rounded-lg border border-zinc-800">
        <svg ref={svgRef} className="w-full block" />
      </div>
    </div>
  );
};
